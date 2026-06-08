# Cosmos CV/OCR Microservice

FastAPI service for business card detection and OCR.

## Python Version Compatibility

| Python | PaddleOCR | Tesseract | Mode |
|--------|-----------|-----------|------|
| 3.11   | ✅ Full   | ✅        | Dual-engine (recommended) |
| 3.12   | ⚠️ Partial| ✅        | Set `PADDLE_DISABLED=1` |
| 3.13+  | ❌        | ✅        | Set `PADDLE_DISABLED=1` |
| 3.14   | ❌        | ✅        | Set `PADDLE_DISABLED=1` |

## Setup — Option A: Python 3.11 (Full dual-engine)

```bash
# Install Python 3.11 (pyenv recommended)
pyenv install 3.11.9
pyenv local 3.11.9

# Create virtualenv
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Install system packages (Ubuntu/Debian)
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng libgl1 libglib2.0-0

# Start the service
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2
```

## Setup — Option B: Python 3.14 (Tesseract-only mode)

```bash
# Create virtualenv
py -m venv .venv
.venv\Scripts\activate  # Windows

# Install dependencies (paddlepaddle line is skipped automatically for 3.12+)
pip install fastapi uvicorn python-multipart numpy opencv-python-headless pytesseract Pillow PyMuPDF

# Set Tesseract-only mode
set PADDLE_DISABLED=1   # Windows CMD
# or
$env:PADDLE_DISABLED="1"  # PowerShell

# Install Tesseract
# Windows: https://github.com/UB-Mannheim/tesseract/wiki
# Ubuntu: sudo apt-get install tesseract-ocr

# Start the service
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Verify

```bash
curl http://localhost:8000/health
# { "status": "ok", "paddleocr": true/false, "tesseract": true }
```

## Docker (Recommended for Production)

Use the Dockerfile at the project root — it uses Python 3.11 with full dual-engine support.
