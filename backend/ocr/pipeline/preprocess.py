"""
Image preprocessing for business-card OCR.

Implements the CV pipeline stages required by the spec:
  perspective correction, deskew, rotation detection, noise reduction,
  CLAHE enhancement, adaptive thresholding, and image quality scoring.

All functions are pure (numpy in -> numpy out) so they are easy to unit-test
and reuse from the card-detection stage.
"""
from __future__ import annotations

import cv2
import numpy as np


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def denoise(img: np.ndarray) -> np.ndarray:
    """Edge-preserving denoise. Bilateral keeps text strokes crisp."""
    return cv2.bilateralFilter(img, d=7, sigmaColor=50, sigmaSpace=50)


def apply_clahe(gray: np.ndarray, clip: float = 2.0, grid: int = 8) -> np.ndarray:
    """Contrast-Limited Adaptive Histogram Equalisation.

    Recovers text on cards photographed under uneven lighting (very common at
    exhibition booths).
    """
    clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(grid, grid))
    return clahe.apply(gray)


def adaptive_threshold(gray: np.ndarray) -> np.ndarray:
    """Binarise for OCR engines that prefer high-contrast input (Tesseract)."""
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 10
    )


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]          # top-left  (smallest x+y)
    rect[2] = pts[np.argmax(s)]          # bottom-right (largest x+y)
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]       # top-right (smallest y-x)
    rect[3] = pts[np.argmax(diff)]       # bottom-left
    return rect


def perspective_correct(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Warp a (possibly skewed) quadrilateral region to a flat rectangle."""
    rect = order_corners(quad.reshape(4, 2).astype("float32"))
    (tl, tr, br, bl) = rect
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    width, height = max(width, 1), max(height, 1)
    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype="float32",
    )
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, M, (width, height))


def estimate_skew_angle(gray: np.ndarray) -> float:
    """Estimate small in-plane skew (degrees) from dominant text lines."""
    edges = cv2.Canny(gray, 50, 150)
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=120, minLineLength=gray.shape[1] // 4,
        maxLineGap=20,
    )
    if lines is None:
        return 0.0
    angles = []
    for x1, y1, x2, y2 in lines[:, 0]:
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if -45 < angle < 45:            # ignore vertical strokes
            angles.append(angle)
    if not angles:
        return 0.0
    return float(np.median(angles))


def deskew(img: np.ndarray) -> tuple[np.ndarray, float]:
    """Rotate the image to make text lines horizontal. Returns (img, degrees)."""
    gray = to_gray(img)
    angle = estimate_skew_angle(gray)
    if abs(angle) < 0.3:
        return img, 0.0
    (h, w) = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    rotated = cv2.warpAffine(
        img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    return rotated, angle


def detect_orientation_osd(gray: np.ndarray) -> int:
    """Coarse 0/90/180/270 orientation via projection-profile variance.

    A correctly-oriented card has higher row-wise variance (text rows create
    strong horizontal bands). Cheap heuristic used before OCR; PaddleOCR also
    has its own angle classifier as a backstop.
    """
    best_angle, best_score = 0, -1.0
    for angle in (0, 90, 180, 270):
        rot = np.rot90(gray, k=angle // 90)
        row_means = rot.mean(axis=1)
        score = float(np.var(row_means))
        if score > best_score:
            best_score, best_angle = score, angle
    return best_angle


def quality_score(img: np.ndarray) -> float:
    """0..1 score combining sharpness, contrast and exposure.

    Used to flag low-quality crops for the reviewer and to weight OCR trust.
    """
    gray = to_gray(img)
    # Sharpness: variance of Laplacian, normalised.
    sharp = cv2.Laplacian(gray, cv2.CV_64F).var()
    sharp_n = min(sharp / 500.0, 1.0)
    # Contrast: std-dev of intensities.
    contrast_n = min(gray.std() / 80.0, 1.0)
    # Exposure: penalise images that are mostly black or mostly white.
    mean = gray.mean() / 255.0
    exposure_n = 1.0 - abs(mean - 0.5) * 2.0
    return round(0.5 * sharp_n + 0.3 * contrast_n + 0.2 * exposure_n, 4)


def sharpen(gray: np.ndarray) -> np.ndarray:
    """Sharpen the image to improve text edge definition for OCR."""
    kernel = np.array([[-1,-1,-1], [-1,9,-1], [-1,-1,-1]])
    return cv2.filter2D(gray, -1, kernel)


def prepare_for_ocr(crop: np.ndarray) -> dict[str, np.ndarray]:
    """Produce engine-specific variants of a single cropped card.

    PaddleOCR works best on the denoised colour/gray image; Tesseract benefits
    from a binarised image.
    """
    deskewed, angle = deskew(crop)
    gray = to_gray(deskewed)
    gray = denoise(gray)
    gray = sharpen(gray)
    enhanced = apply_clahe(gray)
    return {
        "deskewed": deskewed,
        "rotation": angle,
        "paddle_input": enhanced,     # grayscale, contrast-normalised
        "tesseract_input": enhanced,  # grayscale — binarization destroys small text
        "quality": quality_score(deskewed),
    }
