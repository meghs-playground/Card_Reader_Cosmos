"""
Dual-engine OCR with confidence-based fallback.

Spec logic:
    Run PaddleOCR.
    If confidence < 85%  -> run Tesseract.
    Compare outputs, use the highest-confidence result.

PaddleOCR is loaded lazily and cached (model load is expensive). Tesseract is
invoked via pytesseract. Both are optional at import time so the service can
boot even if one engine is not installed — the loader reports availability and
falls back gracefully.

Environment:
    PADDLE_DISABLED=1  — skip PaddleOCR entirely (use on Python 3.12+)
    CONFIDENCE_FALLBACK_THRESHOLD — float 0..1, default 0.85
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

import numpy as np

log = logging.getLogger("ocr")

CONFIDENCE_FALLBACK_THRESHOLD = float(
    os.environ.get("CONFIDENCE_FALLBACK_THRESHOLD", "0.85")
)
PADDLE_DISABLED = os.environ.get("PADDLE_DISABLED", "").lower() in ("1", "true", "yes")


@lru_cache(maxsize=1)
def _get_paddle():
    """Lazily construct a PaddleOCR instance (English; angle classifier on).
    Returns None if PaddlePaddle is unavailable or disabled via env var.
    """
    if PADDLE_DISABLED:
        log.info("PaddleOCR disabled via PADDLE_DISABLED env var")
        return None
    try:
        from paddleocr import PaddleOCR  # type: ignore
        return PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    except Exception as e:
        log.warning("PaddleOCR unavailable: %s", e)
        return None


def _paddle_ocr(image: np.ndarray) -> dict:
    ocr = _get_paddle()
    if ocr is None:
        return {
            "engine": "PADDLEOCR",
            "text": "",
            "confidence": 0.0,
            "lines": [],
            "available": False,
        }
    try:
        result = ocr.ocr(image, cls=True)
        lines, confs = [], []
        # PaddleOCR returns [[ [box], (text, conf) ], ...] per image.
        for page in (result or []):
            for entry in (page or []):
                try:
                    text, conf = entry[1][0], float(entry[1][1])
                except (IndexError, TypeError):
                    continue
                lines.append({"text": text, "confidence": conf})
                confs.append(conf)
        text = "\n".join(ln["text"] for ln in lines)
        confidence = float(np.mean(confs)) if confs else 0.0
        return {
            "engine": "PADDLEOCR",
            "text": text,
            "confidence": confidence,
            "lines": lines,
            "available": True,
        }
    except Exception as e:
        log.error("PaddleOCR inference error: %s", e)
        return {
            "engine": "PADDLEOCR",
            "text": "",
            "confidence": 0.0,
            "lines": [],
            "available": False,
        }


def _tesseract_ocr(image: np.ndarray) -> dict:
    try:
        import pytesseract
        from pytesseract import Output
    except Exception as e:
        log.warning("Tesseract unavailable: %s", e)
        return {
            "engine": "TESSERACT",
            "text": "",
            "confidence": 0.0,
            "lines": [],
            "available": False,
        }
    try:
        config = "--psm 3 --oem 1"
        data = pytesseract.image_to_data(image, config=config, output_type=Output.DICT)
        lines, confs = [], []
        for i, word in enumerate(data["text"]):
            conf = float(data["conf"][i])
            if word.strip() and conf >= 0:
                lines.append({"text": word, "confidence": conf / 100.0})
                confs.append(conf / 100.0)
        text = pytesseract.image_to_string(image, config=config).strip()
        confidence = float(np.mean(confs)) if confs else 0.0
        return {
            "engine": "TESSERACT",
            "text": text,
            "confidence": confidence,
            "lines": lines,
            "available": True,
        }
    except Exception as e:
        log.error("Tesseract inference error: %s", e)
        return {
            "engine": "TESSERACT",
            "text": "",
            "confidence": 0.0,
            "lines": [],
            "available": False,
        }


def run_ocr(paddle_input: np.ndarray, tesseract_input: np.ndarray) -> dict:
    """Execute the spec's dual-engine fallback logic.

    Returns:
        {
          "chosenEngine": "PADDLEOCR" | "TESSERACT" | "MERGED",
          "rawText": str,
          "confidence": float,
          "engineResults": { "paddle": {...}, "tesseract": {...} | None }
        }
    """
    paddle = _paddle_ocr(paddle_input)
    engine_results: dict = {"paddle": paddle, "tesseract": None}

    if paddle["available"] and paddle["confidence"] >= CONFIDENCE_FALLBACK_THRESHOLD:
        return {
            "chosenEngine": "PADDLEOCR",
            "rawText": paddle["text"],
            "confidence": paddle["confidence"],
            "engineResults": engine_results,
        }

    # Confidence too low or Paddle unavailable -> try Tesseract and compare.
    tess = _tesseract_ocr(tesseract_input)
    engine_results["tesseract"] = tess

    candidates = [r for r in [paddle, tess] if r["available"]]
    if not candidates:
        # Both engines failed — return empty result so the pipeline can continue.
        return {
            "chosenEngine": "PADDLEOCR",
            "rawText": "",
            "confidence": 0.0,
            "engineResults": engine_results,
        }

    best = max(candidates, key=lambda r: r["confidence"])
    return {
        "chosenEngine": best["engine"],
        "rawText": best["text"],
        "confidence": best["confidence"],
        "engineResults": engine_results,
    }
