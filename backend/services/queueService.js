/**
 * Background Job Queue — Bull (Redis-backed)
 * -------------------------------------------
 * Wraps the OCR processing pipeline in a Bull queue so:
 *   - Upload endpoint responds immediately (202 Accepted)
 *   - Heavy OCR work runs in background workers
 *   - Jobs survive server restarts (persisted in Redis)
 *   - Concurrency is configurable (default: 2 parallel jobs)
 *   - Failed jobs are retried automatically (3 attempts)
 *
 * Falls back to in-process execution if Redis is unavailable,
 * so the app stays functional in dev without Redis.
 */
const Bull = require("bull");
const { processUpload } = require("./processingService");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CONCURRENCY = parseInt(process.env.OCR_CONCURRENCY || "2", 10);

let queue = null;
let _initialized = false;

function getQueue() {
  // Only attempt Redis connection on first actual call, not on require()
  if (_initialized) return queue;
  _initialized = true;

  try {
    queue = new Bull("ocr-processing", REDIS_URL, {
      redis: {
        connectTimeout: 4000,
        retryStrategy: (times) => {
          if (times > 2) return null;
          return Math.min(times * 200, 1000);
        },
        maxRetriesPerRequest: 1,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,   // keep last 100 completed jobs for debugging
        removeOnFail: 200,
      },
    });
    // If Redis connection fails, fall back gracefully
    queue.on("error", () => { queue = null; });

    // Process jobs with configured concurrency
    queue.process(CONCURRENCY, async (job) => {
      const { uploadId } = job.data;
      job.progress(5);
      const result = await processUpload(uploadId);
      job.progress(100);
      return result;
    });

    queue.on("completed", (job, result) => {
      console.log(
        `[Queue] Job ${job.id} completed: upload ${result.uploadId} → ${result.cards} cards, ${result.leadIds?.length} leads`
      );
    });

    queue.on("failed", (job, err) => {
      console.error(`[Queue] Job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    });

    queue.on("error", (err) => {
      console.error("[Queue] Bull error:", err.message);
    });

    console.log(`[Queue] Bull queue initialized (concurrency: ${CONCURRENCY})`);
  } catch (err) {
    console.warn(`[Queue] Redis unavailable (${err.message}) — using in-process fallback`);
    queue = null;
  }

  return queue;
}

// Serial fallback queue — processes one upload at a time to avoid overwhelming OCR
const _fallbackQueue = [];
let _processingFallback = false;

async function _processNext() {
  if (_processingFallback || _fallbackQueue.length === 0) return;
  _processingFallback = true;
  const uploadId = _fallbackQueue.shift();
  try {
    await processUpload(uploadId);
  } catch (err) {
    console.error(`[Queue] In-process fallback failed for ${uploadId}:`, err.message);
  }
  _processingFallback = false;
  _processNext();
}

/**
 * Enqueue an upload for background processing.
 * Falls back to direct in-process execution if Redis is not available.
 *
 * @param {string} uploadId
 * @returns {Promise<{ jobId: string | null, fallback: boolean }>}
 */
async function enqueueUpload(uploadId) {
  const q = getQueue();

  if (q) {
    try {
      const job = await q.add({ uploadId }, { jobId: uploadId });
      return { jobId: String(job.id), fallback: false };
    } catch (err) {
      console.warn(`[Queue] Failed to enqueue job, falling back: ${err.message}`);
    }
  }

  // Fallback: process one at a time to avoid overwhelming the OCR service
  _fallbackQueue.push(uploadId);
  _processNext();

  return { jobId: null, fallback: true };
}

/**
 * Get queue statistics for the monitoring dashboard.
 * Times out quickly if Redis is unavailable so the health endpoint doesn't hang.
 */
async function getQueueStats() {
  const q = getQueue();
  if (!q) return { active: 0, waiting: 0, completed: 0, failed: 0, redis: false };
  const TIMEOUT = 3000;
  try {
    const counts = await Promise.race([
      Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), TIMEOUT)),
    ]);
    const [waiting, active, completed, failed] = counts;
    return { waiting, active, completed, failed, redis: true };
  } catch {
    return { active: 0, waiting: 0, completed: 0, failed: 0, redis: false };
  }
}

/**
 * Graceful shutdown — drain the queue before exiting.
 */
async function shutdownQueue() {
  if (queue) {
    await queue.close();
    console.log("[Queue] Bull queue closed");
  }
}

/**
 * Reset uploads stuck in DETECTING or EXTRACTING status from a previous crash,
 * and re-enqueue them for processing.
 */
async function resetStuckUploads() {
  const prisma = require("../config/db");
  const stuck = await prisma.upload.findMany({
    where: { status: { in: ["DETECTING", "EXTRACTING"] } },
  });
  for (const u of stuck) {
    await prisma.upload.update({
      where: { id: u.id },
      data: { status: "PENDING", error: null },
    });
    _fallbackQueue.push(u.id);
    console.log(`[Queue] Recovered stuck upload ${u.id} (${u.originalName})`);
  }
  if (stuck.length) _processNext();
  console.log(`[Queue] Recovered ${stuck.length} stuck upload(s)`);
}

module.exports = { enqueueUpload, getQueueStats, shutdownQueue, resetStuckUploads };
