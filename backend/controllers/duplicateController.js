const prisma = require("../config/db");
const { findDuplicates } = require("../services/duplicateDetection");
const { audit } = require("../middleware/audit");

async function scan(req, res, next) {
  try {
    const leads = await prisma.lead.findMany({
      where: { status: { in: ["PENDING_REVIEW", "APPROVED"] } },
      select: { id: true, email: true, phonePrimary: true, companyName: true, city: true },
    });
    const dupes = findDuplicates(leads);
    // Upsert detected pairs.
    for (const d of dupes) {
      await prisma.duplicate.upsert({
        where: { leadAId_leadBId: { leadAId: d.leadAId, leadBId: d.leadBId } },
        create: { ...d },
        update: { score: d.score, reasons: d.reasons },
      });
    }
    res.json({ found: dupes.length });
  } catch (e) { next(e); }
}

async function list(req, res, next) {
  try {
    const items = await prisma.duplicate.findMany({
      where: { status: "OPEN" },
      include: { leadA: { include: { contacts: true } }, leadB: { include: { contacts: true } } },
      orderBy: { score: "desc" },
    });
    res.json(items);
  } catch (e) { next(e); }
}

async function dismiss(req, res, next) {
  try {
    // Accept a single id or a list. Marks the pair DISMISSED so it no longer
    // appears in the OPEN list — and stays gone across refreshes / re-scans.
    const ids = req.body.ids || (req.body.id ? [req.body.id] : []);
    if (!ids.length) return res.status(400).json({ error: "No duplicate id provided" });
    await prisma.duplicate.updateMany({
      where: { id: { in: ids } },
      data: { status: "DISMISSED" },
    });
    await audit(req, "DUPLICATE_DISMISS", "Duplicate", null, { ids });
    res.json({ dismissed: ids.length });
  } catch (e) { next(e); }
}

async function merge(req, res, next) {
  try {
    const { keepId, mergeId } = req.body; // keep keepId, mark mergeId merged
    await prisma.$transaction([
      prisma.lead.update({ where: { id: mergeId }, data: { status: "MERGED", mergedIntoId: keepId } }),
      prisma.duplicate.updateMany({
        where: { OR: [{ leadAId: mergeId }, { leadBId: mergeId }] },
        data: { status: "MERGED" },
      }),
    ]);
    await audit(req, "DUPLICATE_MERGE", "Lead", mergeId, { keepId });
    res.json({ merged: mergeId, into: keepId });
  } catch (e) { next(e); }
}

module.exports = { scan, list, merge, dismiss };
