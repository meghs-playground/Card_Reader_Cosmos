/**
 * Client for the Python CV/OCR microservice.
 * The backend never touches OpenCV/PaddleOCR directly — it POSTs the uploaded
 * file and receives per-card OCR results.
 */
const fs = require("fs");
const FormData = require("form-data");
const axios = require("axios");

const CV_OCR_URL = process.env.CV_OCR_URL || "http://localhost:8000";

async function detectAndOcr(filePath, originalName) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath), originalName);
  form.append("max_cards", "50");
  const { data } = await axios.post(`${CV_OCR_URL}/detect-and-ocr`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 180000,
  });
  return data; // { pages, cards: [...] }
}

module.exports = { detectAndOcr };
