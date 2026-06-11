/**
 * Upload + processing endpoints.
 * Files are received via multer and processed synchronously during the request
 * (while the uploaded file is still available on Render's ephemeral disk).
 */
const path = require("path");
const prisma = require("../config/db");
const { getQueueStats } = require("../services/queueService");
const { processUpload } = require("../services/processingService");
const { audit } = require("../middleware/audit");

async function createUpload(req, res, next) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const results = [];
    const claudeKey = req.body.claude_key || undefined; // dashboard Settings block
    const userId = req.user?.sub || (await prisma.user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id || 'unknown';

    for (const f of req.files) {
      let upload;
      try {
        upload = await prisma.upload.create({
          data: {
            originalName: f.originalname,
            storedPath: f.path,
            mimeType: f.mimetype,
            sizeBytes: f.size,
            source: req.body.source || null,
            uploadedById: userId,
            status: "PENDING",
          },
        });

        if (req.user) {
          await audit(req, "UPLOAD_CREATE", "Upload", upload.id, {
            name: f.originalname,
            size: f.size,
          });
        }

        // Process synchronously while the file is still on disk
        const procResult = await processUpload(upload.id, { claudeKey });
        results.push({
          id: upload.id,
          name: f.originalname,
          status: "READY_FOR_REVIEW",
          pages: procResult.pages,
          cards: procResult.cards,
          leads: procResult.leadIds?.length || 0,
        });
      } catch (e) {
        // Upload record exists but processing failed; status already set to FAILED
        // by processUpload (or we set it here for early failures)
        if (upload && !upload.status) {
          await prisma.upload.update({
            where: { id: upload.id },
            data: { status: "FAILED", error: e.message },
          }).catch(() => {});
        }
        results.push({
          id: upload?.id || null,
          name: f.originalname,
          status: "FAILED",
          error: e.message,
        });
      }
    }

    res.json({ processed: results });
  } catch (e) {
    next(e);
  }
}

async function getUpload(req, res, next) {
  try {
    const upload = await prisma.upload.findUnique({
      where: { id: req.params.id },
      include: { cards: { include: { ocrResult: true, lead: true } } },
    });
    if (!upload) return res.status(404).json({ error: "Not found" });
    res.json(upload);
  } catch (e) {
    next(e);
  }
}

async function reprocessUpload(req, res, next) {
  try {
    const upload = await prisma.upload.findUnique({ where: { id: req.params.id } });
    if (!upload) return res.status(404).json({ error: "Upload not found" });

    // Check if source file still exists
    try {
      require("fs").accessSync(upload.storedPath);
    } catch {
      return res.status(400).json({ error: "Source file no longer exists on server disk. Please re-upload the image." });
    }

    // Delete existing cards + cascade ocrResults
    await prisma.card.deleteMany({ where: { uploadId: upload.id } });

    // Reset status so processUpload picks it up fresh
    await prisma.upload.update({
      where: { id: upload.id },
      data: { status: "PENDING", error: null },
    });

    // Process synchronously
    const procResult = await processUpload(upload.id, { claudeKey: req.body.claude_key || undefined });
    res.json({
      message: "Upload reprocessed",
      id: upload.id,
      pages: procResult.pages,
      cards: procResult.cards,
      leads: procResult.leadIds?.length || 0,
    });
  } catch (e) {
    next(e);
  }
}

async function listQueue(req, res, next) {
  try {
    const { take = 50, skip = 0, status } = req.query;
    const where = status ? { status } : {};

    const [uploads, total, queueStats] = await Promise.all([
      prisma.upload.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(+take, 200),
        skip: +skip,
        include: { _count: { select: { cards: true } } },
      }),
      prisma.upload.count({ where }),
      getQueueStats(),
    ]);

    res.json({ uploads, total, queueStats });
  } catch (e) {
    next(e);
  }
}

module.exports = { createUpload, getUpload, listQueue, reprocessUpload };
