/**
 * Audit logging helper. Call audit(req, action, entityType, entityId, meta)
 * from controllers after a state-changing operation. Failures here never block
 * the request (audit is best-effort but should be monitored).
 */
const prisma = require("../config/db");

async function audit(req, action, entityType, entityId = null, metadata = null) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.user?.sub || null,
        action,
        entityType,
        entityId,
        metadata: metadata || undefined,
        ip: req.ip,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("audit log failed:", e.message);
  }
}

module.exports = { audit };
