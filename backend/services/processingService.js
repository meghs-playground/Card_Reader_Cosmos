/**
 * Processing Pipeline Orchestrator
 * --------------------------------
 * Runs an upload through extraction and persists the results.
 *
 * Two extraction engines, chosen automatically per upload:
 *
 *   1. Claude Vision (preferred, when CLAUDE_API_KEY is set and the file is a
 *      supported image under the size limit) — one API call returns every card
 *      on the page already structured. Higher accuracy, no local OCR needed.
 *
 *   2. Python CV/OCR microservice (PaddleOCR / Tesseract) + regex entity
 *      extraction — the fallback. Used when Claude is disabled, the file is a
 *      PDF / too large, or the Claude call fails for any reason.
 *
 * Both engines funnel through persistCardLead() so the persisted shape — Card,
 * OcrResult, Company, Lead, Contacts — is identical regardless of engine.
 *
 *   Upload(row exists)
 *     -> Claude Vision   OR   CV/OCR service (detect + OCR each card)
 *     -> entity normalisation
 *     -> validation + geo resolution
 *     -> upsert Company (dedupe) + create Lead + Contacts
 *     -> Upload.status = READY_FOR_REVIEW
 */
const fs = require("fs");
const path = require("path");
const prisma = require("../config/db");
const { detectAndOcr } = require("./cvOcrClient");
const claudeVision = require("./claudeVisionClient");
const { extractEntities } = require("./entityExtraction");
const { validateLead } = require("./validation");

const CROPS_DIR = process.env.CROPS_DIR || path.resolve("uploads/crops");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Save a base64-encoded crop image returned by the OCR service, or a raw
 * buffer, to disk. Returns the relative file path stored in the DB.
 * Falls back gracefully — pipeline continues even if crop save fails.
 */
function saveCropImage(uploadId, cardIndex, pageIndex, cropData) {
  try {
    ensureDir(CROPS_DIR);
    const filename = `${uploadId}_p${pageIndex}_c${cardIndex}.jpg`;
    const filePath = path.join(CROPS_DIR, filename);

    if (Buffer.isBuffer(cropData)) {
      fs.writeFileSync(filePath, cropData);
    } else if (typeof cropData === "string" && cropData.startsWith("data:")) {
      // base64 data URL from OCR service
      const base64 = cropData.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    } else {
      return "";
    }
    return filePath;
  } catch (e) {
    console.error(`[processingService] Failed to save crop: ${e.message}`);
    return "";
  }
}

function normalizedCompanyKey(name, website) {
  const n = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const domain = (website || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  const key = `${n}::${domain}`;
  return key.length > 2 ? key.slice(0, 250) : `unknown::${Date.now()}`;
}

async function upsertCompany(tx, entities, geo) {
  if (!entities.companyName) return null;
  const key = normalizedCompanyKey(entities.companyName, entities.website);
  return tx.company.upsert({
    where: { normalizedKey: key },
    create: {
      name: entities.companyName,
      normalizedKey: key,
      website: entities.website || null,
      domain:
        (entities.website || "")
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0] || null,
      industry: entities.industry || null,
      gstin: entities.gstin || null,
      city: geo.city || null,
      state: geo.state || null,
      country: geo.country || null,
      postalCode: entities.postalCode || null,
    },
    update: {
      website: entities.website || undefined,
      gstin: entities.gstin || undefined,
      industry: entities.industry || undefined,
      city: geo.city || undefined,
      state: geo.state || undefined,
      country: geo.country || undefined,
    },
  });
}

/**
 * Normalise a raw Claude Vision card into the same `entities` shape that
 * extractEntities() produces, so it can share the persistence path.
 */
function entitiesFromClaudeCard(card) {
  const contacts =
    Array.isArray(card.contacts) && card.contacts.length
      ? card.contacts
      : [{ name: null, designation: null, email: null, phone: null, mobile: null, isPrimary: true }];
  const primary = contacts.find((c) => c.isPrimary) || contacts[0];
  const firstEmail = primary?.email || contacts.map((c) => c.email).find(Boolean) || null;

  return {
    companyName: card.company || null,
    website: card.website || null,
    email: firstEmail,
    phonePrimary: primary?.mobile || primary?.phone || null,
    phoneSecondary: null,
    address: card.address || null,
    postalCode: card.postalCode || null,
    gstin: card.gstin || null,
    industry: card.industry || null,
    linkedin: card.linkedin || null,
    twitter: null,
    facebook: null,
    instagram: null,
    youtube: null,
    whatsapp: null,
    // Claude already resolves geo; persistCardLead prefers these over validation.
    city: card.city || null,
    state: card.state || null,
    country: card.country || null,
    contacts: contacts.map((c) => ({
      fullName: c.name || null,
      designation: c.designation || null,
      department: null,
      email: c.email || null,
      mobile: c.mobile || null,
      phone: c.phone || null,
      isPrimary: !!c.isPrimary,
    })),
    // 0..1 confidence from Claude (overrides the heuristic score when present).
    _aiConfidence: typeof card.confidence === "number" ? Math.min(card.confidence / 100, 1) : null,
  };
}

/**
 * Persist one card -> Card + OcrResult + Company + Lead + Contacts.
 * Shared by both the Claude Vision and Python OCR paths.
 *
 * @param upload    the Upload row
 * @param meta      { pageIndex, cardIndex, bbox, quadrilateral, rotationApplied,
 *                    qualityScore, cropBase64, chosenEngine, rawText, confidence,
 *                    engineResults }
 * @param entities  normalised entity object (from extractEntities or Claude)
 * @returns lead id
 */
async function persistCardLead(upload, meta, entities) {
  const croppedPath = saveCropImage(upload.id, meta.cardIndex, meta.pageIndex, meta.cropBase64 || "");

  const card = await prisma.card.create({
    data: {
      uploadId: upload.id,
      pageIndex: meta.pageIndex,
      cardIndex: meta.cardIndex,
      croppedPath,
      bbox: meta.bbox || undefined,
      quadrilateral: meta.quadrilateral || undefined,
      rotationApplied: meta.rotationApplied || 0,
      qualityScore: meta.qualityScore || 0,
    },
  });

  await prisma.ocrResult.create({
    data: {
      cardId: card.id,
      chosenEngine: meta.chosenEngine || "TESSERACT",
      rawText: meta.rawText || "",
      confidence: meta.confidence || 0,
      engineResults: meta.engineResults || {},
    },
  });

  const { fields, geo, overallConfidence } = validateLead(entities);

  // Claude provides geo directly; the regex path relies on validation's resolver.
  const finalGeo = {
    city: entities.city || geo.city || null,
    state: entities.state || geo.state || null,
    country: entities.country || geo.country || null,
  };

  const company = await upsertCompany(prisma, entities, finalGeo);

  const aiConfidence =
    entities._aiConfidence != null ? entities._aiConfidence : overallConfidence;

  const lead = await prisma.lead.create({
    data: {
      cardId: card.id,
      companyId: company?.id || null,
      companyName: entities.companyName || null,
      website: entities.website || null,
      email: entities.email || null,
      phonePrimary: entities.phonePrimary || null,
      phoneSecondary: entities.phoneSecondary || null,
      address: entities.address || null,
      city: finalGeo.city,
      state: finalGeo.state,
      country: finalGeo.country,
      postalCode: entities.postalCode || null,
      gstin: entities.gstin || null,
      industry: entities.industry || null,
      linkedin: entities.linkedin || null,
      twitter: entities.twitter || null,
      facebook: entities.facebook || null,
      instagram: entities.instagram || null,
      youtube: entities.youtube || null,
      whatsapp: entities.whatsapp || null,
      aiConfidence,
      validation: fields,
      source: upload.source || null,
      status: "PENDING_REVIEW",
      contacts: {
        create: (entities.contacts || []).map((ct) => ({
          fullName: ct.fullName || null,
          designation: ct.designation || null,
          department: ct.department || null,
          email: ct.email || null,
          mobile: ct.mobile || null,
          phone: ct.phone || null,
          isPrimary: !!ct.isPrimary,
        })),
      },
    },
  });

  return lead.id;
}

/** Auto-scan duplicates after an upload finishes (best-effort, non-blocking). */
function scheduleDuplicateScan() {
  setImmediate(async () => {
    try {
      const { findDuplicates } = require("./duplicateDetection");
      const leads = await prisma.lead.findMany({
        where: { status: { in: ["PENDING_REVIEW", "APPROVED"] } },
        select: { id: true, email: true, phonePrimary: true, companyName: true, city: true },
      });
      const dupes = findDuplicates(leads);
      for (const d of dupes) {
        await prisma.duplicate.upsert({
          where: { leadAId_leadBId: { leadAId: d.leadAId, leadBId: d.leadBId } },
          create: { ...d },
          update: { score: d.score, reasons: d.reasons },
        });
      }
    } catch (_) {
      /* non-critical */
    }
  });
}

async function processUpload(uploadId) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) throw new Error(`Upload ${uploadId} not found`);

  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: "DETECTING", error: null },
  });

  // ── Path 1: Claude Vision (preferred for supported images) ─────────────────
  if (claudeVision.canHandle(upload.mimeType, upload.sizeBytes)) {
    try {
      const cards = await claudeVision.extractCards(upload.storedPath, upload.mimeType);

      if (Array.isArray(cards) && cards.length) {
        await prisma.upload.update({
          where: { id: uploadId },
          data: { status: "EXTRACTING", pageCount: 1 },
        });

        const createdLeadIds = [];
        for (let i = 0; i < cards.length; i++) {
          try {
            const entities = entitiesFromClaudeCard(cards[i]);
            const leadId = await persistCardLead(
              upload,
              {
                pageIndex: 0,
                cardIndex: i,
                chosenEngine: "MERGED", // enum has no CLAUDE; tagged via engineResults
                rawText: JSON.stringify(cards[i]),
                confidence: entities._aiConfidence || 0,
                engineResults: { source: "claude-vision", model: claudeVision.CLAUDE_MODEL },
              },
              entities
            );
            createdLeadIds.push(leadId);
          } catch (err) {
            console.error(
              `[processUpload] Claude card ${i} failed for upload ${uploadId}: ${err.message}`
            );
            // continue — one bad card must not lose the rest of the batch
          }
        }

        console.log(
          `[processUpload] Upload ${uploadId}: created ${createdLeadIds.length} leads via Claude Vision`
        );
        await prisma.upload.update({
          where: { id: uploadId },
          data: { status: "READY_FOR_REVIEW" },
        });
        scheduleDuplicateScan();
        return { uploadId, pages: 1, cards: cards.length, leadIds: createdLeadIds };
      }
      // Claude returned no cards — fall through to the OCR pipeline.
      console.warn(
        `[processUpload] Claude Vision found no cards for upload ${uploadId}; falling back to OCR`
      );
    } catch (e) {
      console.warn(
        `[processUpload] Claude Vision failed for upload ${uploadId} (${e.message}); falling back to OCR`
      );
    }
  }

  // ── Path 2: Python CV/OCR microservice + regex extraction (fallback) ───────
  let result;
  try {
    result = await detectAndOcr(upload.storedPath, upload.originalName);
  } catch (e) {
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: "FAILED", error: `CV/OCR service: ${e.message}` },
    });
    throw e;
  }

  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: "EXTRACTING", pageCount: result.pages },
  });

  const createdLeadIds = [];

  for (const c of result.cards) {
    try {
      const entities = extractEntities(c.ocr.rawText);
      const leadId = await persistCardLead(
        upload,
        {
          pageIndex: c.pageIndex,
          cardIndex: c.cardIndex,
          cropBase64: c.cropBase64 || "",
          bbox: c.bbox ? { x: c.bbox[0], y: c.bbox[1], w: c.bbox[2], h: c.bbox[3] } : undefined,
          quadrilateral: c.quadrilateral || undefined,
          rotationApplied: c.rotationApplied || 0,
          qualityScore: c.qualityScore || 0,
          chosenEngine: c.ocr.chosenEngine || "TESSERACT",
          rawText: c.ocr.rawText || "",
          confidence: c.ocr.confidence || 0,
          engineResults: c.ocr.engineResults || {},
        },
        entities
      );
      createdLeadIds.push(leadId);
    } catch (err) {
      console.error(
        `[processUpload] Failed processing card ${c.cardIndex} for upload ${uploadId}: ${err.message}`,
        err.stack
      );
      throw err;
    }
  }

  console.log(`[processUpload] Upload ${uploadId}: created ${createdLeadIds.length} leads via OCR`);
  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: "READY_FOR_REVIEW" },
  });

  scheduleDuplicateScan();

  return {
    uploadId,
    pages: result.pages,
    cards: result.cards.length,
    leadIds: createdLeadIds,
  };
}

module.exports = { processUpload };
