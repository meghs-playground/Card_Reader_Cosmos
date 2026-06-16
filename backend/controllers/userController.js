/**
 * User management — super-admin only (mounted behind authorize("ADMIN")).
 * List accounts, activate/deactivate, and change roles. Deactivated users are
 * blocked at login (authController checks isActive).
 */
const prisma = require("../config/db");
const { audit } = require("../middleware/audit");

const ROLES = ["ADMIN", "REVIEWER", "UPLOADER", "VIEWER"];

async function list(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        _count: { select: { uploads: true } },
      },
    });
    res.json(users.map((u) => ({ ...u, uploads: u._count.uploads, _count: undefined })));
  } catch (e) {
    next(e);
  }
}

async function update(req, res, next) {
  try {
    const { id } = req.params;
    const data = {};
    if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;
    if (req.body.role && ROLES.includes(req.body.role)) data.role = req.body.role;
    if (!Object.keys(data).length) {
      return res.status(400).json({ error: "Nothing to update (isActive or role)" });
    }

    // Guard: an admin must not lock themselves out or demote their own account.
    if (id === req.user.sub && (data.isActive === false || (data.role && data.role !== "ADMIN"))) {
      return res.status(400).json({ error: "You cannot deactivate or demote your own admin account" });
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    audit(req, "USER_UPDATE", "User", id, data).catch(() => {});
    res.json(user);
  } catch (e) {
    next(e);
  }
}

module.exports = { list, update };
