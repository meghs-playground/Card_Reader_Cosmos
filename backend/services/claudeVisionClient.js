/**
 * Claude Vision client (server-side).
 * ----------------------------------
 * Sends a business-card image to the Anthropic API and gets back structured,
 * per-card data in one step (OCR + understanding + extraction). This runs on
 * the backend — the API key never reaches the browser, and there is no CORS
 * issue (unlike calling api.anthropic.com directly from the frontend).
 *
 * Enabled only when CLAUDE_API_KEY is set. Callers should treat any thrown
 * error as "fall back to the Python OCR pipeline" — see processingService.js.
 *
 * Env:
 *   CLAUDE_API_KEY  — Anthropic API key from https://console.anthropic.com
 *                     (separate product from a Claude Pro subscription)
 *   CLAUDE_MODEL    — model id, default "claude-opus-4-8"
 */
const fs = require("fs");
const axios = require("axios");

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

// Anthropic rejects images above ~5 MB. Larger uploads fall back to the Python
// pipeline (which downscales). Base64 inflates ~33%, so guard the raw bytes.
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const SUPPORTED_MIME = /^image\/(jpeg|png|webp|gif)$/;

const PROMPT = `You are a business-card data extraction engine for an Indian B2B CRM.
The image may contain ONE card or MANY business cards on a single page. Detect EVERY distinct card and extract its data separately.

Return ONLY a valid JSON object — no markdown, no commentary — in exactly this shape:
{
  "cards": [
    {
      "company": "string or null",
      "website": "domain without http/www — string or null",
      "gstin": "15-char Indian GST number e.g. 27ABCDE1234F1Z5 — string or null",
      "address": "full street address — string or null",
      "city": "string or null",
      "state": "full state name. Derive from GSTIN first 2 digits if present: 24=Gujarat 27=Maharashtra 29=Karnataka 33=Tamil Nadu 07=Delhi 06=Haryana 08=Rajasthan 09=Uttar Pradesh 36=Telangana 23=Madhya Pradesh 19=West Bengal 03=Punjab 30=Goa — string or null",
      "country": "string or null — default India if a +91 number or a GSTIN is present",
      "postalCode": "PIN code — string or null",
      "linkedin": "LinkedIn URL or handle — string or null",
      "industry": "industry sector e.g. Manufacturing, Precision Machining, Automotive, Electronics — string or null",
      "contacts": [
        {
          "name": "person full name — string or null",
          "designation": "job title — string or null",
          "email": "string or null",
          "phone": "office/landline with country code — string or null",
          "mobile": "mobile/cell with country code — string or null",
          "isPrimary": true
        }
      ],
      "confidence": 90
    }
  ]
}

Rules:
- List every person found on a card in that card's contacts array.
- The first / main person on each card has isPrimary true, others false.
- If a field is not present, use null. Do not invent data.
- confidence is an integer 0-100 reflecting how clearly the card was read.
- If no business card is visible, return {"cards": []}.`;

/**
 * The key may come from the backend env (CLAUDE_API_KEY) or be passed per
 * request from the dashboard Settings block. The env var wins when both exist.
 */
function resolveKey(keyOverride) {
  return CLAUDE_API_KEY || (keyOverride || "").trim();
}

function isEnabled(keyOverride) {
  return !!resolveKey(keyOverride);
}

/**
 * Whether this upload should go through Claude Vision (vs the Python pipeline).
 * @param {string} mimeType
 * @param {number} sizeBytes
 * @param {string} [keyOverride] per-request key from the dashboard Settings block
 */
function canHandle(mimeType, sizeBytes, keyOverride) {
  return (
    isEnabled(keyOverride) &&
    SUPPORTED_MIME.test(mimeType || "") &&
    (sizeBytes || 0) <= MAX_IMAGE_BYTES
  );
}

/**
 * Extract every card from an image file.
 * @param {string} filePath
 * @param {string} mimeType
 * @param {string} [keyOverride] per-request key from the dashboard Settings block
 * @returns {Promise<Array>} array of raw card objects (see PROMPT shape)
 * @throws on any API / parse error — caller falls back to Python OCR
 */
async function extractCards(filePath, mimeType, keyOverride) {
  const apiKey = resolveKey(keyOverride);
  if (!apiKey) throw new Error("No Claude API key available");

  const buffer = fs.readFileSync(filePath);
  const b64 = buffer.toString("base64");
  const mediaType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

  let resp;
  try {
    resp = await axios.post(
      CLAUDE_URL,
      {
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
  } catch (e) {
    // Surface a useful message so the fallback log is actionable.
    const status = e.response?.status;
    const apiMsg = e.response?.data?.error?.message;
    if (status === 401) throw new Error("Claude API: invalid API key (401)");
    if (status === 400 && /credit|billing/i.test(apiMsg || ""))
      throw new Error("Claude API: insufficient credit — add funds in the console");
    throw new Error(`Claude API request failed: ${apiMsg || e.message}`);
  }

  const text = (resp.data.content || []).map((b) => b.text || "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude response contained no JSON");

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
  CLAUDE_MODEL,
  MODEL: CLAUDE_MODEL,
  SOURCE: "claude-vision",
  PROMPT,
};
