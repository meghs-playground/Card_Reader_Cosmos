/**
 * Lead review + lifecycle endpoints: list, get, edit, approve, reject, merge,
 * bulk approve/reject, delete. All mutations are audited.
 */
const prisma = require("../config/db");
const { audit } = require("../middleware/audit");

const LEAD_INCLUDE = {
  contacts: true,
  company: true,
  card: { include: { ocrResult: true } },
};

// Explicit allowlist of fields a reviewer may edit on a Lead.
// Prevents mass-assignment: status, aiConfidence, mergedIntoId etc. are NOT here.
const EDITABLE_LEAD_FIELDS = new Set([
  "companyName",
  "website",
  "email",
  "phonePrimary",
  "phoneSecondary",
  "address",
  "city",
  "state",
  "country",
  "postalCode",
  "gstin",
  "industry",
  "linkedin",
  "twitter",
  "facebook",
  "instagram",
  "youtube",
  "whatsapp",
  "qrCodeData",
  "notes",
  "source",
]);

function pickEditableFields(body) {
  const out = {};
  for (const key of EDITABLE_LEAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      out[key] = body[key];
    }
  }
  return out;
}

async function listLeads(req, res, next) {
  try {
    const { status, q, take = 50, skip = 0 } = req.query;
    const where = { deletedAt: null }; // hide trashed leads from the active list
    // Employees (non-admin) see only the leads they scanned. The owner is the
    // user who uploaded the lead's source card. ADMIN (super-admin) sees all.
    if (req.user && req.user.role !== "ADMIN") {
      where.card = { upload: { uploadedById: req.user.sub } };
    }
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { companyName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: LEAD_INCLUDE,
        orderBy: { createdAt: "desc" },
        take: Math.min(+take, 200), // cap at 200 rows per request
        skip: +skip,
      }),
      prisma.lead.count({ where }),
    ]);
    res.json({ items, total });
  } catch (e) {
    next(e);
  }
}

async function getLead(req, res, next) {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: LEAD_INCLUDE,
    });
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (e) {
    next(e);
  }
}

async function updateLead(req, res, next) {
  try {
    const { contacts, ...rawFields } = req.body;

    // Only allow explicitly listed fields — block status, aiConfidence, etc.
    const safeFields = pickEditableFields(rawFields);

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: {
        ...safeFields,
        updatedAt: new Date(),
        ...(contacts
          ? {
              contacts: {
                deleteMany: {},
                create: contacts.map((c) => ({
                  fullName: c.fullName ?? null,
                  designation: c.designation ?? null,
                  department: c.department ?? null,
                  email: c.email ?? null,
                  mobile: c.mobile ?? null,
                  phone: c.phone ?? null,
                  isPrimary: !!c.isPrimary,
                })),
              },
            }
          : {}),
      },
      include: LEAD_INCLUDE,
    });
    await audit(req, "LEAD_UPDATE", "Lead", lead.id);
    res.json(lead);
  } catch (e) {
    next(e);
  }
}

async function approve(req, res, next) {
  try {
    const ids = req.body.ids || [req.params.id];
    if (!ids.length) return res.status(400).json({ error: "No IDs provided" });
    await prisma.lead.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "APPROVED",
        reviewedById: req.user.sub,
        reviewedAt: new Date(),
      },
    });
    await audit(req, "LEAD_APPROVE", "Lead", null, { ids });
    res.json({ approved: ids.length });
  } catch (e) {
    next(e);
  }
}

async function reject(req, res, next) {
  try {
    const ids = req.body.ids || [req.params.id];
    if (!ids.length) return res.status(400).json({ error: "No IDs provided" });
    await prisma.lead.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "REJECTED",
        reviewedById: req.user.sub,
        reviewedAt: new Date(),
      },
    });
    await audit(req, "LEAD_REJECT", "Lead", null, { ids });
    res.json({ rejected: ids.length });
  } catch (e) {
    next(e);
  }
}

/** Ownership guard: non-admins may only act on their own leads. */
async function ownsLeadOr404(req, res) {
  if (req.user && req.user.role !== "ADMIN") {
    const owned = await prisma.lead.findFirst({
      where: { id: req.params.id, card: { upload: { uploadedById: req.user.sub } } },
      select: { id: true },
    });
    if (!owned) { res.status(404).json({ error: "Lead not found" }); return false; }
  }
  return true;
}

/** Soft delete — move the lead to Trash (recoverable for 30 days). */
async function remove(req, res, next) {
  try {
    if (!(await ownsLeadOr404(req, res))) return;
    await prisma.lead.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    await audit(req, "LEAD_TRASH", "Lead", req.params.id);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

/** List trashed leads (in Trash), scoped to owner for non-admins. */
async function listTrash(req, res, next) {
  try {
    const where = { deletedAt: { not: null } };
    if (req.user && req.user.role !== "ADMIN") {
      where.card = { upload: { uploadedById: req.user.sub } };
    }
    const items = await prisma.lead.findMany({
      where,
      include: LEAD_INCLUDE,
      orderBy: { deletedAt: "desc" },
      take: 200,
    });
    res.json({ items, total: items.length });
  } catch (e) {
    next(e);
  }
}

/** Restore a lead from Trash. */
async function restore(req, res, next) {
  try {
    if (!(await ownsLeadOr404(req, res))) return;
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { deletedAt: null },
      include: LEAD_INCLUDE,
    });
    await audit(req, "LEAD_RESTORE", "Lead", req.params.id);
    res.json(lead);
  } catch (e) {
    next(e);
  }
}

/** Permanently delete a lead (from Trash). */
async function purge(req, res, next) {
  try {
    if (!(await ownsLeadOr404(req, res))) return;
    await prisma.lead.delete({ where: { id: req.params.id } });
    await audit(req, "LEAD_DELETE_PERMANENT", "Lead", req.params.id);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
}

module.exports = { listLeads, getLead, updateLead, approve, reject, remove, listTrash, restore, purge };
