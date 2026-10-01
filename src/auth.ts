// JWT authentication. The user's identity is ALWAYS the token's `sub` claim — never a body field —
// so a request can only ever act as the user who holds the token.
import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";
import { DomainError } from "./errors.js";

export type Role = "user" | "admin";

export interface AuthUser {
  id: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

const secret = new TextEncoder().encode(config.JWT_SECRET);
const TOKEN_TTL = "24h";

export async function signToken(userId: string, role: Role): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret);
}

async function verifyToken(token: string): Promise<AuthUser> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("token has no subject");
    return { id: payload.sub, role: payload.role === "admin" ? "admin" : "user" };
  } catch {
    throw new DomainError("unauthorized");
  }
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new DomainError("unauthorized");
  return token;
}

export const requireUser: RequestHandler = async (req, _res, next) => {
  req.user = await verifyToken(bearerToken(req));
  next();
};

export const requireAdmin: RequestHandler = async (req, _res, next) => {
  req.user = await verifyToken(bearerToken(req));
  if (req.user.role !== "admin") throw new DomainError("forbidden");
  next();
};

// Use inside a handler that sits behind requireUser/requireAdmin.
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new DomainError("unauthorized");
  return req.user;
}

// Constant-time comparison so the admin key can't be guessed byte-by-byte from response timing.
export function isValidAdminKey(candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(config.ADMIN_API_KEY);
  const given = Buffer.from(candidate);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
