/**
 * Processing Pipeline Orchestrator
 * --------------------------------
 * Runs an upload through every stage and persists the results:
 *
 *   Upload(row exists)
 *     -> CV/OCR service: detect cards + OCR each   (cvOcrClient)
 *     -> per card: save crop image to disk         (CROPS_DIR)
 *     -> persist Card + OcrResult
 *     -> entity extraction                          (entityExtraction)
 *     -> validation + geo resolution               (validation)
 *     -> upsert Company (dedupe) + create Lead + Contacts
 *     -> Upload.status = READY_FOR_REVIEW
 */
const fs = require("fs");
const path = require("path");
const prisma = require("../config/db");
const { detectAndOcr } = require("./cvOcrClient");
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

async function processUpload(uploadId) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) throw new Error(`Upload ${uploadId} not found`);

  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: "DETECTING", error: null },
  });

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
    const croppedPath = saveCropImage(uploadId, c.cardIndex, c.pageIndex, c.cropBase64 || "");

    try {
      const card = await prisma.card.create({
        data: {
          uploadId, pageIndex: c.pageIndex, cardIndex: c.cardIndex,
          croppedPath,
          bbox: c.bbox ? { x: c.bbox[0], y: c.bbox[1], w: c.bbox[2], h: c.bbox[3] } : undefined,
          quadrilateral: c.quadrilateral || undefined,
          rotationApplied: c.rotationApplied || 0, qualityScore: c.qualityScore || 0,
        },
      });

      await prisma.ocrResult.create({
        data: {
          cardId: card.id,
          chosenEngine: c.ocr.chosenEngine || "TESSERACT",
          rawText: c.ocr.rawText || "", confidence: c.ocr.confidence || 0,
          engineResults: c.ocr.engineResults || {},
        },
      });

      const entities = extractEntities(c.ocr.rawText);
      const { fields, geo, overallConfidence } = validateLead(entities);
      const company = await upsertCompany(prisma, entities, geo);

      const lead = await prisma.lead.create({
        data: {
          cardId: card.id, companyId: company?.id || null,
          companyName: entities.companyName || null, website: entities.website || null,
          email: entities.email || null, phonePrimary: entities.phonePrimary || null,
          phoneSecondary: entities.phoneSecondary || null, address: entities.address || null,
          city: geo.city || null, state: geo.state || null, country: geo.country || null,
          postalCode: entities.postalCode || null, gstin: entities.gstin || null,
          industry: entities.industry || null, linkedin: entities.linkedin || null,
          twitter: entities.twitter || null, facebook: entities.facebook || null,
          instagram: entities.instagram || null, youtube: entities.youtube || null,
          whatsapp: entities.whatsapp || null, aiConfidence: overallConfidence,
          validation: fields, source: upload.source || null, status: "PENDING_REVIEW",
          contacts: {
            create: (entities.contacts || []).map((ct) => ({
              fullName: ct.fullName || null, designation: ct.designation || null,
              department: ct.department || null, email: ct.email || null,
              mobile: ct.mobile || null, phone: ct.phone || null, isPrimary: !!ct.isPrimary,
            })),
          },
        },
      });
      createdLeadIds.push(lead.id);
    } catch (err) {
      console.error(`[processUpload] Failed processing card ${c.cardIndex} for upload ${uploadId}: ${err.message}`, err.stack);
      throw err;
    }
  }

  console.log(`[processUpload] Upload ${uploadId}: created ${createdLeadIds.length} leads`);
  await prisma.upload.update({
    where: { id: uploadId },
    data: { status: "READY_FOR_REVIEW" },
  });

  // Auto-scan duplicates after processing completes
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
    } catch (_) { /* non-critical */ }
  });

  return {
    uploadId,
    pages: result.pages,
    cards: result.cards.length,
    leadIds: createdLeadIds,
  };
}

module.exports = { processUpload };
