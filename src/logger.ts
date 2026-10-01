// Structured JSON logging. Every request gets a request id (from X-Request-Id or generated),
// echoed back in the response header and attached to every log line written for that request.
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import { ulid } from "ulid";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "seat-reservation" },
  // Never write credentials to logs.
  redact: ["req.headers.authorization", 'req.headers["x-admin-key"]'],
});

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Probes and scrapes are polled constantly; logging them would drown out real traffic.
const QUIET_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

export const httpLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : ulid();
    res.setHeader("X-Request-Id", requestId);
    return requestId;
  },
  customProps: (req) => ({ req_id: req.id }),
  autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url ?? "") },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ status: res.statusCode }),
  },
});
