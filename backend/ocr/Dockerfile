# ── Python 3.11 — required for PaddleOCR (paddle has no 3.12+ wheels) ────────
FROM python:3.11-slim AS runtime

# PADDLE_DISABLED defaults to 0 here so a build straight from this Dockerfile
# (e.g. Render) runs BOTH engines, matching docker-compose. Override to 1 only
# on hosts where PaddlePaddle cannot fit in memory or is unavailable.
# The thread caps below keep PaddlePaddle's CPU/RAM footprint small enough to
# coexist with Tesseract on constrained (e.g. 512 MB) instances.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_DISABLED=0 \
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
