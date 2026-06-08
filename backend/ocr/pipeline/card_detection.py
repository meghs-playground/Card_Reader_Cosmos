"""
Multi-card detection & segmentation.

CRITICAL REQUIREMENT (from spec): one page may contain N business cards
(e.g. 10 cards on a single scanned A4 sheet). This module finds each card,
returns its quadrilateral + axis-aligned bbox, and perspective-corrects each
into its own crop so every card becomes an independent OCR/lead/CSV row.

Strategy:
  1. Downscale for fast contour work.
  2. Edge map (Canny) + morphological close to bridge text gaps so each card
     reads as one solid blob rather than many letters.
  3. Find external contours, approximate to polygons, keep 4-ish-sided,
     rectangular, card-sized blobs (aspect ratio ~ 1.4..2.2, the ISO/US card
     range, with tolerance).
  4. Reject overlaps (non-max suppression by area/IoU).
  5. Fallback: if nothing card-like is found (e.g. a single tightly-cropped
     photo of one card), treat the whole page as one card.

This is heuristic CV, not a trained detector. For booths that hand out highly
non-standard cards, swap step 3 for a fine-tuned detector (e.g. YOLOv8) behind
the same interface — `detect_cards()` returns the same structure either way.
"""
from __future__ import annotations

import cv2
import numpy as np

from .preprocess import perspective_correct

# Business cards: ISO 7810 ID-1 (3.37 x 2.13") and US (3.5 x 2") => ~1.45..1.75.
# Allow a generous band to tolerate skew/measurement error.
MIN_ASPECT, MAX_ASPECT = 1.2, 2.4
# A card must occupy at least this fraction of the page area to be considered
# (filters out logos/QR codes), and at most this much (filters page-as-card
# only when several are present).
MIN_AREA_FRAC = 0.02
MAX_AREA_FRAC = 0.95


def _iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    if inter == 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union


def _suppress_overlaps(candidates, iou_thresh=0.3):
    """Greedy NMS keeping the larger box on overlap."""
    candidates = sorted(candidates, key=lambda c: c["bbox"][2] * c["bbox"][3],
                        reverse=True)
    kept = []
    for cand in candidates:
        if all(_iou(cand["bbox"], k["bbox"]) < iou_thresh for k in kept):
            kept.append(cand)
    return kept


def detect_cards(image: np.ndarray, max_cards: int = 50) -> list[dict]:
    """Detect business cards in a page image.

    Returns a list of dicts:
        { "bbox": (x,y,w,h),
          "quad": np.ndarray(4,2),    # corner points in source coords
          "crop": np.ndarray }        # perspective-corrected card image
    Ordered top-to-bottom, left-to-right (reading order).
    """
    H, W = image.shape[:2]
    page_area = float(H * W)

    # 1. Downscale for speed; keep scale to map coords back.
    scale = 1200.0 / max(H, W) if max(H, W) > 1200 else 1.0
    small = cv2.resize(image, None, fx=scale, fy=scale) if scale != 1.0 else image.copy()
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    # 2. Edges + morphological close to merge each card into a solid region.
    edges = cv2.Canny(gray, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    closed = cv2.dilate(closed, kernel, iterations=1)

    # 3. Contours -> polygon approximation -> card filter.
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL,
                                    cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        small_area = small.shape[0] * small.shape[1]
        if area < MIN_AREA_FRAC * small_area or area > MAX_AREA_FRAC * small_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        rect = cv2.minAreaRect(cnt)
        (w_box, h_box) = rect[1]
        if w_box == 0 or h_box == 0:
            continue
        aspect = max(w_box, h_box) / min(w_box, h_box)
        if not (MIN_ASPECT <= aspect <= MAX_ASPECT):
            continue
        box = cv2.boxPoints(rect)
        # Map coords back to full-resolution space.
        quad = (box / scale).astype("float32")
        x, y, w, h = cv2.boundingRect((quad).astype("int32"))
        candidates.append({"bbox": (x, y, w, h), "quad": quad})

    candidates = _suppress_overlaps(candidates)

    # 5. Fallback: nothing detected -> whole page is a single card.
    if not candidates:
        quad = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype="float32")
        candidates = [{"bbox": (0, 0, W, H), "quad": quad}]

    # Reading order: top-to-bottom, then left-to-right (row-banded sort).
    candidates.sort(key=lambda c: (round(c["bbox"][1] / (H * 0.15)), c["bbox"][0]))
    candidates = candidates[:max_cards]

    results = []
    for c in candidates:
        crop = perspective_correct(image, c["quad"])
        # Guard against degenerate crops.
        if crop.size == 0 or min(crop.shape[:2]) < 20:
            x, y, w, h = c["bbox"]
            crop = image[y:y + h, x:x + w]
        results.append({"bbox": c["bbox"], "quad": c["quad"], "crop": crop})
    return results
