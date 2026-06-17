const prisma = require("../config/db");
const { findDuplicates } = require("../services/duplicateDetection");
const { audit } = require("../middleware/audit");

async function scan(req, res, next) {
  try {
    const leads = await prisma.lead.findMany({
      where: { deletedAt: null, status: { in: ["PENDING_REVIEW", "APPROVED"] } },
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

// Scalar fields copied from the merged lead into blank fields of the kept lead.
const MERGE_FIELDS = [
  "companyName", "website", "email", "phonePrimary", "phoneSecondary", "address",
  "city", "state", "country", "postalCode", "gstin", "industry", "linkedin",
  "twitter", "facebook", "instagram", "youtube", "whatsapp", "qrCodeData", "notes",
];

/**
 * Merge two duplicate leads into ONE combined lead:
 *  - the kept lead absorbs any field the merged lead has but it was missing,
 *  - non-duplicate contacts from the merged lead are copied over,
 *  - the merged lead is marked MERGED and moved to Trash (recoverable 30 days).
 */
async function merge(req, res, next) {
  try {
    const { keepId, mergeId } = req.body;
    if (!keepId || !mergeId || keepId === mergeId) {
      return res.status(400).json({ error: "keepId and mergeId (different) are required" });
    }
    const [keep, gone] = await Promise.all([
      prisma.lead.findUnique({ where: { id: keepId }, include: { contacts: true } }),
      prisma.lead.findUnique({ where: { id: mergeId }, include: { contacts: true } }),
    ]);
    if (!keep || !gone) return res.status(404).json({ error: "Lead not found" });

    // Fill blank fields on the kept lead from the merged lead.
    const data = {};
    for (const f of MERGE_FIELDS) {
      if ((keep[f] === null || keep[f] === undefined || keep[f] === "") && gone[f]) data[f] = gone[f];
    }
    // Copy contacts that aren't already present (matched on email + phone/mobile).
    const keyOf = (c) => `${(c.email || "").toLowerCase()}|${(c.mobile || c.phone || "").replace(/\D/g, "")}`;
    const have = new Set(keep.contacts.map(keyOf));
    const newContacts = gone.contacts.filter((c) => {
      const k = keyOf(c);
      if (k === "|" || have.has(k)) return false;
      have.add(k);
      return true;
    });

    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.lead.update({ where: { id: keepId }, data });
      for (const c of newContacts) {
        await tx.contact.create({
          data: {
            leadId: keepId,
            fullName: c.fullName, designation: c.designation, department: c.department,
            email: c.email, mobile: c.mobile, phone: c.phone, isPrimary: false,
          },
        });
      }
      await tx.lead.update({
        where: { id: mergeId },
        data: { status: "MERGED", mergedIntoId: keepId, deletedAt: new Date() },
      });
      await tx.duplicate.updateMany({
        where: { OR: [{ leadAId: mergeId }, { leadBId: mergeId }] },
        data: { status: "MERGED" },
      });
    });

    await audit(req, "DUPLICATE_MERGE", "Lead", mergeId, {
      keepId, fieldsFilled: Object.keys(data), contactsMoved: newContacts.length,
    });
    res.json({
      merged: mergeId, into: keepId,
      fieldsFilled: Object.keys(data).length, contactsMoved: newContacts.length,
    });
  } catch (e) { next(e); }
}

module.exports = { scan, list, merge, dismiss };
