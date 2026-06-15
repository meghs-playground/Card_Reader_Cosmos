/**
 * Groq vision client (server-side).
 * ---------------------------------
 * Same job as claudeVisionClient, but against Groq's OpenAI-compatible API
 * using a Llama 4 multimodal model. Groq is very fast and has a generous free
 * tier, so it's a good no-cost-ish alternative to Claude for card extraction.
 *
 * Returns the SAME per-card shape as claudeVisionClient (see PROMPT), so the
 * pipeline treats both engines identically.
 *
 * Routing: a key starting with "gsk_" (the Groq key prefix) is sent here; an
 * "sk-ant-" key goes to Claude. See processingService.pickVisionEngine().
 *
 * Env:
 *   GROQ_API_KEY  — Groq API key from https://console.groq.com (starts gsk_)
 *   GROQ_MODEL    — vision-capable model id; default a Llama 4 multimodal model.
 *                   If Groq renames/retires it, set this env var to a current
 *                   vision model from https://console.groq.com/docs/models
 */
const fs = require("fs");
const axios = require("axios");
const { PROMPT } = require("./claudeVisionClient");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Groq accepts base64 images up to ~4 MB. Larger uploads fall back to OCR.
const MAX_IMAGE_BYTES = 3.8 * 1024 * 1024;
const SUPPORTED_MIME = /^image\/(jpeg|png|webp|gif)$/;

function resolveKey(keyOverride) {
  return GROQ_API_KEY || (keyOverride || "").trim();
}

function isEnabled(keyOverride) {
  return !!resolveKey(keyOverride);
}

function canHandle(mimeType, sizeBytes, keyOverride) {
  return (
    isEnabled(keyOverride) &&
    SUPPORTED_MIME.test(mimeType || "") &&
    (sizeBytes || 0) <= MAX_IMAGE_BYTES
  );
}

/**
 * Extract every card from an image file via Groq.
 * @throws on any API / parse error — caller falls back to Python OCR
 */
async function extractCards(filePath, mimeType, keyOverride) {
  const apiKey = resolveKey(keyOverride);
  if (!apiKey) throw new Error("No Groq API key available");

  const buffer = fs.readFileSync(filePath);
  const b64 = buffer.toString("base64");
  const mediaType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

  let resp;
  try {
    resp = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        max_tokens: 8000,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${b64}` } },
            ],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
  } catch (e) {
    const status = e.response?.status;
    const apiMsg = e.response?.data?.error?.message;
    if (status === 401) throw new Error("Groq API: invalid API key (401)");
    if (status === 429) throw new Error("Groq API: rate limit / quota exceeded (429)");
    if (status === 404 || /model/i.test(apiMsg || ""))
      throw new Error(`Groq API: model '${GROQ_MODEL}' unavailable — set GROQ_MODEL to a current vision model (${apiMsg || ""})`);
    throw new Error(`Groq API request failed: ${apiMsg || e.message}`);
  }

  const text = resp.data.choices?.[0]?.message?.content || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Groq response contained no JSON");

  const parsed = JSON.parse(match[0]);
  const cards = Array.isArray(parsed.cards)
    ? parsed.cards
    : parsed.company !== undefined
    ? [parsed]
    : [];
  return cards;
}

module.exports = {
  isEnabled,
  canHandle,
  extractCards,
  MODEL: GROQ_MODEL,
  SOURCE: "groq-vision",
};
