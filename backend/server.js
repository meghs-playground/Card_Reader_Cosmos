require("dotenv").config();
const { app } = require("./app");
const prisma = require("./config/db");
const { shutdownQueue } = require("./services/queueService");

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, async () => {
  console.log(`Cosmos backend listening on :${PORT} [${process.env.NODE_ENV || "development"}]`);

  // Warm up OCR service to avoid cold-start timeout
  try {
    const axios = require("axios");
    const ocrUrl = process.env.CV_OCR_URL || "http://localhost:8000";
    axios.get(`${ocrUrl}/health`, { timeout: 15000 }).catch(() => {});
  } catch (_) {}

  // Recover uploads stuck from a previous crash
  try {
    const { resetStuckUploads } = require("./services/queueService");
    await resetStuckUploads();
  } catch (_) {}
});

async function shutdown(signal) {
  console.log(`Received ${signal} — shutting down gracefully`);
  server.close(async () => {
    await shutdownQueue();
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
