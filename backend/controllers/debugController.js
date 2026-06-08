const prisma = require("../config/db");

async function createTestLead(req, res, next) {
  try {
    // Find a READY_FOR_REVIEW upload with a card and no lead
    const upload = await prisma.upload.findFirst({
      where: { status: "READY_FOR_REVIEW" },
      include: { cards: { include: { lead: true, ocrResult: true }, take: 1 } },
    });
    if (!upload || !upload.cards.length) {
      return res.status(400).json({ error: "No suitable upload found" });
    }
    const card = upload.cards[0];
    if (card.lead) {
      return res.json({ message: "Card already has a lead", lead: card.lead });
    }

    // Manually create a lead for this card
    const entities = { companyName: "Test Company" };
    const lead = await prisma.lead.create({
      data: {
        cardId: card.id,
        companyName: "Test Company (from /api/debug/test-lead)",
        email: "test@example.com",
        status: "PENDING_REVIEW",
      },
    });

    res.json({
      message: "Test lead created",
      lead,
      cardId: card.id,
      ocrRawText: card.ocrResult?.rawText?.substring(0, 200) || "no OCR text",
    });
  } catch (e) {
    next(e);
  }
}

async function testTransactionLead(req, res, next) {
  try {
    // Find a card that has no lead
    const upload = await prisma.upload.findFirst({
      where: { status: "READY_FOR_REVIEW", cards: { some: { lead: null } } },
      include: { cards: { where: { lead: null }, take: 1 } },
      orderBy: { createdAt: "desc" },
    });
    if (!upload || !upload.cards.length) {
      return res.status(400).json({ error: "No suitable upload/card found" });
    }
    const card = upload.cards[0];

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const company = await tx.company.upsert({
          where: { normalizedKey: "test-company::test.com" },
          create: { name: "Test Company", normalizedKey: "test-company::test.com", website: "test.com" },
          update: {},
        });
        const lead = await tx.lead.create({
          data: {
            cardId: card.id,
            companyId: company.id,
            companyName: "Test Company (from tx)",
            email: "tx-test@example.com",
            status: "PENDING_REVIEW",
          },
        });
        return { company, lead };
      });
      res.json({
        message: "Transaction succeeded",
        company: result.company,
        lead: result.lead,
        cardId: card.id,
      });
    } catch (txErr) {
      res.status(500).json({
        error: "Transaction failed",
        message: txErr.message,
        stack: txErr.stack?.split("\n").slice(0, 5).join("\n"),
      });
    }
  } catch (e) {
    next(e);
  }
}

async function testFullPipelineTx(req, res, next) {
  try {
    const upload = await prisma.upload.findFirst({
      where: { status: "READY_FOR_REVIEW" },
      orderBy: { createdAt: "desc" },
    });
    if (!upload) return res.status(400).json({ error: "No upload found" });

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Step 1: Create a test card
        const card = await tx.card.create({
          data: {
            uploadId: upload.id,
            pageIndex: 0,
            cardIndex: 99,
            croppedPath: "",
            bbox: { x: 0, y: 0, w: 100, h: 100 },
          },
        });

        // Step 2: Create OCR result
        await tx.ocrResult.create({
          data: {
            cardId: card.id,
            chosenEngine: "TESSERACT",
            rawText: "Test Company\nContact: John Doe\njohn@test.com",
            confidence: 0.9,
            engineResults: {},
          },
        });

        // Step 3: Upsert company
        const company = await tx.company.upsert({
          where: { normalizedKey: "test-full-pipeline::test.com" },
          create: {
            name: "Test Full Pipeline",
            normalizedKey: "test-full-pipeline::test.com",
          },
          update: {},
        });

        // Step 4: Create lead WITH contacts nested create
        const lead = await tx.lead.create({
          data: {
            cardId: card.id,
            companyId: company.id,
            companyName: "Test Full Pipeline",
            email: "john@test.com",
            status: "PENDING_REVIEW",
            contacts: {
              create: [
                {
                  fullName: "John Doe",
                  designation: "Manager",
                  isPrimary: true,
                },
              ],
            },
          },
        });

        return { card, company, lead };
      });

      res.json({
        message: "Full pipeline transaction succeeded",
        card: { id: result.card.id },
        company: { id: result.company.id, name: result.company.name },
        lead: { id: result.lead.id, email: result.lead.email },
      });
    } catch (txErr) {
      res.status(500).json({
        error: "Transaction failed",
        message: txErr.message,
        code: txErr.code,
        stack: txErr.stack?.split("\n").slice(0, 8).join("\n"),
      });
    }
  } catch (e) {
    next(e);
  }
}

function normalizedCompanyKey(name, website) {
  const n = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const domain = (website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const key = `${n}::${domain}`;
  return key.length > 2 ? key.slice(0, 250) : `unknown::${Date.now()}`;
}

async function upsertCompany(tx, entities, geo) {
  if (!entities.companyName) return null;
  const key = normalizedCompanyKey(entities.companyName, entities.website);
  return tx.company.upsert({
    where: { normalizedKey: key },
    create: {
      name: entities.companyName, normalizedKey: key,
      website: entities.website || null,
      domain: (entities.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || null,
      industry: entities.industry || null, gstin: entities.gstin || null,
      city: geo.city || null, state: geo.state || null, country: geo.country || null,
      postalCode: entities.postalCode || null,
    },
    update: {
      website: entities.website || undefined, gstin: entities.gstin || undefined,
      industry: entities.industry || undefined, city: geo.city || undefined,
      state: geo.state || undefined, country: geo.country || undefined,
    },
  });
}

async function simulateProcessing(req, res, next) {
  try {
    const { id } = req.params;
    const upload = await prisma.upload.findUnique({ where: { id } });
    if (!upload) return res.status(404).json({ error: "Upload not found" });

    // Step through exactly what processUpload does
    const steps = [];
    const { detectAndOcr } = require("../services/cvOcrClient");
    const { extractEntities } = require("../services/entityExtraction");
    const { validateLead } = require("../services/validation");

    // Step 1: Call OCR service
    steps.push({ step: "detectAndOcr", status: "pending" });
    let result;
    try {
      result = await detectAndOcr(upload.storedPath, upload.originalName);
      steps[0].status = "ok";
      steps[0].pages = result.pages;
      steps[0].cardCount = result.cards?.length;
    } catch (e) {
      steps[0].status = "error";
      steps[0].error = e.message;
      return res.json({ upload: upload.id, filePath: upload.storedPath, steps });
    }

    // Process each card
    for (let i = 0; i < result.cards.length; i++) {
      const c = result.cards[i];
      steps.push({ step: `card_${i}`, status: "pending", cardIndex: c.cardIndex });

      try {
        // Step 2: Begin transaction
        const txResult = await prisma.$transaction(async (tx) => {
          const card = await tx.card.create({
            data: {
              uploadId: upload.id, pageIndex: c.pageIndex, cardIndex: c.cardIndex,
              croppedPath: "", bbox: c.bbox ? { x: c.bbox[0], y: c.bbox[1], w: c.bbox[2], h: c.bbox[3] } : undefined,
              quadrilateral: c.quadrilateral || undefined,
              rotationApplied: c.rotationApplied || 0, qualityScore: c.qualityScore || 0,
            },
          });
          const ocr = await tx.ocrResult.create({
            data: {
              cardId: card.id,
              chosenEngine: c.ocr?.chosenEngine || "TESSERACT",
              rawText: c.ocr?.rawText || "", confidence: c.ocr?.confidence || 0,
              engineResults: c.ocr?.engineResults || {},
            },
          });
          const entities = extractEntities(c.ocr?.rawText || "");
          let validation;
          try {
            validation = validateLead(entities);
          } catch (ve) {
            return { error: `validateLead threw: ${ve.message}`, entities };
          }
          const { fields, geo, overallConfidence } = validation;
          let company = null;
          try {
            company = await upsertCompany(tx, entities, geo);
          } catch (ce) {
            return { error: `upsertCompany threw: ${ce.message}`, entities };
          }

          let lead;
          try {
            lead = await tx.lead.create({
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
          } catch (le) {
            return { error: `lead.create threw: ${le.message}`, code: le.code, entities };
          }

          return { card, ocr, company, lead };
        });

        if (txResult.error) {
          steps[i + 1].status = "error";
          steps[i + 1].txError = txResult.error;
          steps[i + 1].entities = txResult.entities;
        } else {
          steps[i + 1].status = "ok";
          steps[i + 1].cardId = txResult.card?.id;
          steps[i + 1].leadId = txResult.lead?.id;
        }
      } catch (txErr) {
        steps[i + 1].status = "error";
        steps[i + 1].txError = txErr.message;
        steps[i + 1].txCode = txErr.code;
      }
    }

    res.json({ upload: upload.id, filePath: upload.storedPath, steps });
  } catch (e) {
    next(e);
  }
}

async function dbStats(req, res, next) {
  try {
    const [uploads, cards, ocrResults, leads, companies, contacts, users] =
      await Promise.all([
        prisma.upload.findMany({
          select: { id: true, status: true, originalName: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.card.count(),
        prisma.ocrResult.count(),
        prisma.lead.count(),
        prisma.company.count(),
        prisma.contact.count(),
        prisma.user.count(),
      ]);

    const statusCounts = {};
    for (const u of uploads) {
      statusCounts[u.status] = (statusCounts[u.status] || 0) + 1;
    }

    const uploadsWithLeads = uploads.filter(
      (u) => u.status === "READY_FOR_REVIEW"
    ).length;
    const recentUploads = uploads.slice(0, 5).map((u) => ({
      id: u.id,
      name: u.originalName,
      status: u.status,
      createdAt: u.createdAt,
    }));

    res.json({
      counts: {
        uploads: uploads.length,
        cards,
        ocrResults,
        leads,
        companies,
        contacts,
        users,
      },
      statusBreakdown: statusCounts,
      readyForReviewCount: uploadsWithLeads,
      leadGap: { readyForReview: uploadsWithLeads, leadsCreated: leads },
      recentUploads,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { dbStats, createTestLead, testTransactionLead, testFullPipelineTx, simulateProcessing };
