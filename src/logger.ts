// Structured JSON logging. Every request gets a request id (from X-Request-Id or generated),
// echoed back in the response header and attached to every log line written for that request.
import { randomUUID } from "node:crypto";
import { destination, pino } from "pino";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: "seat-reservation" },
    // Never write credentials to logs.
    redact: ["req.headers.authorization", 'req.headers["x-admin-key"]'],
  },
  // Asynchronous writes, so logging thousands of lines a second doesn't block the event loop.
  // minLength 0 = no batching: each line is written as soon as possible. (A 4 KB batch looked
  // fine under a burst but held single log lines back indefinitely when traffic was quiet.)
  destination({ sync: false, minLength: 0 }),
);

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Probes and scrapes are polled constantly; logging them would drown out real traffic.
const QUIET_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

export const httpLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
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
