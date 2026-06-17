const prisma = require("../config/db");
const { generateExport } = require("../services/exportService");
const { audit } = require("../middleware/audit");

async function buildAndStream(req, res, next, format) {
  try {
    const where = { deletedAt: null }; // never export trashed leads
    if (req.query.status && req.query.status !== 'all') {
      where.status = req.query.status === 'Extracted' ? 'PENDING_REVIEW' : req.query.status.toUpperCase();
    } else {
      where.status = { not: 'REJECTED' };
    }
    if (req.query.source) where.source = req.query.source;

    // Employees export only the leads they scanned; ADMIN exports everyone's.
    if (req.user && req.user.role !== "ADMIN") {
      where.card = { upload: { uploadedById: req.user.sub } };
    }

    // Optional date range (date-wise CSV). `to` is inclusive of the whole day.
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt.gte = new Date(req.query.from);
      if (req.query.to) {
        const t = new Date(req.query.to);
        t.setHours(23, 59, 59, 999);
        where.createdAt.lte = t;
      }
    }

    const leads = await prisma.lead.findMany({
      where,
      include: { contacts: true, company: true },
      // Most recently reviewed/approved first — a lead approved just now is
      // the first data row in the exported file.
      orderBy: [
        { reviewedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
    });

    const { filePath, fileName, rowCount } = await generateExport(leads, format, {
      salesBranchBySource: {}, // configurable mapping event->branch
    });

    const userId = req.user?.sub || (await prisma.user.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id || 'unknown';
    const exportRow = await prisma.export.create({
      data: {
        format, storedPath: filePath, leadCount: rowCount,
        filters: where, createdById: userId,
      },
    });
    if (req.user) {
      await audit(req, `EXPORT_${format}`, "Export", exportRow.id, { rowCount });
    }

    res.download(filePath, fileName);
  } catch (e) { next(e); }
}

module.exports = {
  csv: (req, res, next) => buildAndStream(req, res, next, "CSV"),
  xlsx: (req, res, next) => buildAndStream(req, res, next, "XLSX"),
  json: (req, res, next) => buildAndStream(req, res, next, "JSON"),
};
