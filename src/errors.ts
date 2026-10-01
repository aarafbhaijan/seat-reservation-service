// One error type for every expected failure, and one middleware that turns errors into
// the JSON envelope { error: { code, message, request_id } }.
// Rule: domain declines are 4xx. Only real bugs become 500; an unreachable DB becomes 503.
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

const ERRORS = {
  invalid_request: { status: 400, message: "The request is invalid" },
  unauthorized: { status: 401, message: "Missing or invalid token" },
  forbidden: { status: 403, message: "You are not allowed to do this" },
  not_found: { status: 404, message: "Not found" },
  seat_taken: { status: 409, message: "One or more seats are not available" },
  per_user_limit: { status: 409, message: "This would exceed your seat limit for the show" },
  idempotency_key_conflict: {
    status: 409,
    message: "This idempotency key was already used with a different request",
  },
  unknown_seat: { status: 422, message: "One or more seats do not exist in this show" },
  unavailable: { status: 503, message: "Service temporarily unavailable" },
  internal_error: { status: 500, message: "Internal server error" },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERRORS[code].message);
    this.code = code;
    this.httpStatus = ERRORS[code].status;
    this.details = details;
  }
}

// Connection-level MySQL failures mean "the database is unreachable" -> fail closed with 503.
const DATABASE_DOWN_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
]);

function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;

  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join("."),
      issue: issue.message,
    }));
    return new DomainError("invalid_request", undefined, { issues });
  }

  const err = error as { type?: string; code?: string };
  if (err.type === "entity.parse.failed")
    return new DomainError("invalid_request", "Body is not valid JSON");
  if (err.code && DATABASE_DOWN_CODES.has(err.code)) return new DomainError("unavailable");

  return new DomainError("internal_error");
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const domainError = toDomainError(error);

  if (domainError.httpStatus >= 500) {
    req.log.error({ err: error, code: domainError.code }, "request failed");
  }

  res.status(domainError.httpStatus).json({
    error: {
      code: domainError.code,
      message: domainError.message,
      request_id: req.id,
      ...(domainError.details ?? {}),
    },
  });
};

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new DomainError("not_found", "Route not found"));
};
