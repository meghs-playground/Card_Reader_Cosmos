/**
 * REST API routes. Mirrors the endpoint list in the spec, with auth + RBAC.
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { authenticate, authorize } = require("../middleware/auth");
const upload = require("../controllers/uploadController");
const lead = require("../controllers/leadController");
const debug = require("../controllers/debugController");
const dup = require("../controllers/duplicateController");
const exp = require("../controllers/exportController");
const analytics = require("../controllers/analyticsController");
const auth = require("../controllers/authController");

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve("uploads/raw");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.-]/g, "_")}`),
});
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const uploadMw = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 200 },
  fileFilter: (_, file, cb) =>
    cb(ALLOWED.includes(file.mimetype) ? null : new Error("Unsupported file type"), ALLOWED.includes(file.mimetype)),
});

const router = express.Router();

// ---- Public routes (no auth required) ----
router.post("/auth/login", auth.login);
router.post("/auth/register", auth.register); // employee self-signup

// ============================================================================
// Everything below requires a valid token. Each request now carries req.user,
// which drives per-employee scoping (employees see only their own leads) and
// attribution (uploads are tagged with the uploader).
// ============================================================================
router.use(authenticate);

// ---- Auth ----
router.post("/auth/logout", auth.logout);
router.get("/auth/me", auth.me);

// ---- Upload + processing ----
router.post("/upload", uploadMw.array("files", 200), upload.createUpload);
router.get("/uploads", upload.listQueue);
router.get("/uploads/:id", upload.getUpload);
router.post("/uploads/:id/reprocess", upload.reprocessUpload);

// ---- Leads (read scoped to owner for non-admins, in the controller) ----
router.get("/leads", lead.listLeads);
router.get("/leads/:id", lead.getLead);
router.delete("/leads/:id", lead.remove);
router.put("/leads/:id", authorize("ADMIN", "REVIEWER"), lead.updateLead);
router.post("/leads/approve", authorize("ADMIN", "REVIEWER"), lead.approve);    // body: { ids: [] }
router.post("/leads/:id/approve", authorize("ADMIN", "REVIEWER"), lead.approve);
router.post("/leads/reject", authorize("ADMIN", "REVIEWER"), lead.reject);      // body: { ids: [] }
router.post("/leads/:id/reject", authorize("ADMIN", "REVIEWER"), lead.reject);

// ---- Duplicates ----
router.get("/duplicates", dup.list);
router.post("/duplicates/scan", authorize("ADMIN", "REVIEWER"), dup.scan);
router.post("/duplicates/merge", authorize("ADMIN", "REVIEWER"), dup.merge);
router.post("/duplicates/dismiss", authorize("ADMIN", "REVIEWER"), dup.dismiss);

// ---- Analytics / reports ----
router.get("/analytics", analytics.getDashboard);
router.get("/reports", analytics.getReports);
router.get("/reports/employees", authorize("ADMIN"), analytics.getEmployeeReport); // super-admin only

// ---- Export (scoped to owner for non-admins, in the controller) ----
router.get("/export/csv", exp.csv);
router.get("/export/xlsx", exp.xlsx);
router.get("/export/json", exp.json);

// ---- Debug (admin only) ----
router.get("/debug", authorize("ADMIN"), debug.dbStats);
router.get("/debug/test-lead", authorize("ADMIN"), debug.createTestLead);
router.get("/debug/test-tx-lead", authorize("ADMIN"), debug.testTransactionLead);
router.get("/debug/test-full-tx", authorize("ADMIN"), debug.testFullPipelineTx);
router.get("/debug/simulate/:id", authorize("ADMIN"), debug.simulateProcessing);

module.exports = router;
