# ── Python 3.11 — required for PaddleOCR (paddle has no 3.12+ wheels) ────────
FROM python:3.11-slim AS runtime

# PADDLE_DISABLED=1 (Tesseract-only) by default. PaddleOCR is more accurate but
# needs ~1 GB RAM: on a 512 MB instance (e.g. Render free tier) it loads, serves
# one slow request (~90s), then OOM-crashes the whole service. Verified live.
# To enable BOTH engines, set PADDLE_DISABLED=0 AND run on >= 1 GB RAM.
# The thread caps below shrink PaddlePaddle's footprint if/when you re-enable it.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_DISABLED=1 \
    CONFIDENCE_FALLBACK_THRESHOLD=0.85 \
    PDF_RASTER_DPI=150 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    FLAGS_use_mkldnn=0 \
    GLOG_minloglevel=2

WORKDIR /app

# System dependencies for OpenCV + Tesseract
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-hin \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    wget \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN addgroup --gid 1001 cosmos \
    && adduser --uid 1001 --ingroup cosmos --disabled-password --gecos "" cosmos

COPY --chown=cosmos:cosmos . .

USER cosmos

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8000/health || exit 1

# Single worker to stay within Render free-tier memory (512 MB)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
