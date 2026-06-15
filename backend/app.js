require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const routes = require("./routes");
const { notFound, errorHandler } = require("./middleware/error");
const { createLogger } = require("./middleware/logger");

const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ────────────────────────────────────────────────────────────────────
// Never fall back to wildcard. CORS_ORIGIN must be set in .env.
// In production set to your exact frontend domain.
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    "[CORS] WARNING: CORS_ORIGIN not set. All cross-origin requests will be blocked."
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, same-origin).
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  })
);

// ── Rate limiters ────────────────────────────────────────────────────────────
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10); // 15 min

// General API limiter
const generalLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_MAX || "200", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Strict limiter for auth endpoints (brute-force protection)
const authLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "30", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later." },
});

// Upload limiter (large file processing is expensive)
const uploadLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "50", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Upload rate limit exceeded." },
});

// Export limiter
const exportLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.EXPORT_RATE_LIMIT_MAX || "30", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Export rate limit exceeded." },
});

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

// ── Logging ──────────────────────────────────────────────────────────────────
app.use(createLogger());

// ── Health check (no auth, no rate limit) ────────────────────────────────────
app.get("/health", async (_, res) => {
  // Lazy imports so they don't block app startup
  const prisma = require("./config/db");
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (_e) { /* db unreachable during health check */ }

  let queueStats = { redis: false };
  try {
    const { getQueueStats } = require("./services/queueService");
    queueStats = await getQueueStats();
  } catch (_e) { /* redis unreachable */ }

  const status = dbOk ? "ok" : "degraded";
  res.status(dbOk ? 200 : 503).json({
    status,
    env: process.env.NODE_ENV,
    db: dbOk ? "ok" : "unreachable",
    queue: queueStats,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Routes with per-route rate limiting ──────────────────────────────────────
// Only the login endpoint is brute-force sensitive — limit just that, so that
// /auth/me and /auth/logout (called on normal page loads) don't burn the budget
// and trip "too many attempts" during regular use.
app.use("/api/auth/login", authLimiter);
app.use("/api/upload", uploadLimiter);
app.use("/api/export", exportLimiter);
app.use("/api", generalLimiter, routes);

// ── Error handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = { app, authLimiter, uploadLimiter, exportLimiter };
