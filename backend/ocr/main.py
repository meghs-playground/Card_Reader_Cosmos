"""
CV / OCR microservice (FastAPI).

Endpoints:
  POST /detect-and-ocr   multipart image OR pdf-page image -> per-card OCR
  GET  /health           engine availability

Kept as a separate service from the Node backend because the CV/OCR stack
(OpenCV, PaddleOCR, Tesseract, PyMuPDF) is Python-native and CPU/GPU-heavy.
The Node backend calls this over HTTP (see backend/services/cvOcrClient.js).
PDFs are rasterised page-by-page here so the backend only deals with leads.

Environment variables:
  PADDLE_DISABLED=1              — use Tesseract-only mode (Python 3.12+)
  CONFIDENCE_FALLBACK_THRESHOLD  — default 0.85
  PDF_RASTER_DPI                 — default 200
"""
from __future__ import annotations

import logging
import os

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse

from pipeline.card_detection import detect_cards
from pipeline.preprocess import prepare_for_ocr
from pipeline.ocr import run_ocr, _get_paddle

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cosmos-ocr")

PDF_RASTER_DPI = int(os.environ.get("PDF_RASTER_DPI", "200"))
MAX_IMAGE_DIM = 2500  # downscale to save memory on Render's free tier

app = FastAPI(title="Cosmos CV/OCR Service", version="1.1.0")


def _resize_if_large(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    if max(h, w) > MAX_IMAGE_DIM:
        scale = MAX_IMAGE_DIM / max(h, w)
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return img


def _read_image(data: bytes) -> np.ndarray:
    # Use PIL to handle EXIF orientation (phones embed rotation in metadata)
    from PIL import Image as PILImage
    import io
    try:
        pil_img = PILImage.open(io.BytesIO(data))
        pil_img = PILImage.ImageOps.exif_transpose(pil_img) or pil_img
        img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception:
        arr = np.frombuffer(data, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unsupported or corrupt image")
    return _resize_if_large(img)


def _pdf_to_images(data: bytes, dpi: int = PDF_RASTER_DPI) -> list[np.ndarray]:
    """Rasterise each PDF page to a BGR image using PyMuPDF."""
    import fitz  # PyMuPDF
    pages = []
    doc = fitz.open(stream=data, filetype="pdf")
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    for page in doc:
        pix = page.get_pixmap(matrix=mat)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n
        )
        if pix.n == 4:
            img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
        else:
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        pages.append(_resize_if_large(img))
    return pages


@app.get("/health")
def health():
    return {
        "status": "ok",
        "paddle_disabled": os.environ.get("PADDLE_DISABLED", "0") in ("1", "true"),
        "tesseract": _check_tesseract(),
        "python_version": __import__("sys").version,
    }


def _check_tesseract() -> bool:
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


@app.post("/detect-and-ocr")
async def detect_and_ocr(
    file: UploadFile = File(...),
    max_cards: int = Form(50),
):
    """Detect every card across every page, OCR each, return structured rows.

    Response:
      { "pages": <int>,
        "cards": [
          { "pageIndex": int, "cardIndex": int,
            "bbox": [x,y,w,h], "rotationApplied": float, "qualityScore": float,
            "ocr": { chosenEngine, rawText, confidence, engineResults } }
        ] }
    """
    data = await file.read()
    name = (file.filename or "").lower()

    try:
        if name.endswith(".pdf") or file.content_type == "application/pdf":
            pages = _pdf_to_images(data)
        else:
            pages = [_read_image(data)]
    except Exception as e:
        log.error("File read error: %s", e)
        return JSONResponse(status_code=400, content={"error": str(e)})

    out_cards = []
    for page_index, page_img in enumerate(pages):
        try:
            cards = detect_cards(page_img, max_cards=max_cards)
        except Exception as e:
            log.error("Card detection error on page %d: %s", page_index, e)
            # Fall back to treating the whole page as one card.
            H, W = page_img.shape[:2]
            quad = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype="float32")
            cards = [{"bbox": (0, 0, W, H), "quad": quad, "crop": page_img}]

        for card_index, card in enumerate(cards):
            try:
                prep = prepare_for_ocr(card["crop"])
                ocr = run_ocr(prep["paddle_input"], prep["tesseract_input"])
                x, y, w, h = card["bbox"]
                out_cards.append({
                    "pageIndex": page_index,
                    "cardIndex": card_index,
                    "bbox": [int(x), int(y), int(w), int(h)],
                    "quadrilateral": card["quad"].astype(int).tolist(),
                    "rotationApplied": float(prep["rotation"]),
                    "qualityScore": float(prep["quality"]),
                    "ocr": ocr,
                })
            except Exception as e:
                log.error(
                    "OCR error on page %d card %d: %s", page_index, card_index, e
                )
                # Include a failed-card entry so the pipeline knows it existed.
                out_cards.append({
                    "pageIndex": page_index,
                    "cardIndex": card_index,
                    "bbox": list(card["bbox"]),
                    "quadrilateral": [],
                    "rotationApplied": 0.0,
                    "qualityScore": 0.0,
                    "ocr": {
                        "chosenEngine": "TESSERACT",
                        "rawText": "",
                        "confidence": 0.0,
                        "engineResults": {"paddle": None, "tesseract": None},
                    },
                })

    return {"pages": len(pages), "cards": out_cards}
