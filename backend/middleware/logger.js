/**
 * Structured JSON logger middleware.
 * In production, outputs JSON lines that can be ingested by any log aggregator.
 * In development, uses morgan's readable 'dev' format.
 */
const morgan = require("morgan");

// Custom JSON token for request ID (for distributed tracing)
morgan.token("reqId", (req) => req.headers["x-request-id"] || "-");
morgan.token("userId", (req) => req.user?.sub || "anon");

const JSON_FORMAT = JSON.stringify({
  time: ":date[iso]",
  method: ":method",
  url: ":url",
  status: ":status",
  ms: ":response-time",
  bytes: ":res[content-length]",
  reqId: ":reqId",
  userId: ":userId",
  ip: ":remote-addr",
});

function createLogger() {
  if (process.env.NODE_ENV === "production") {
    return morgan(JSON_FORMAT, {
      skip: (req) => req.url === "/health", // don't log health checks
    });
  }
  return morgan("dev");
}

module.exports = { createLogger };
