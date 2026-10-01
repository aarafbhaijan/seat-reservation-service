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

// Checking a signature is the most CPU-expensive thing a request does, and a stampede sends
// the same token many times. A token can't change, so once its signature checks out we
// remember the result and only re-check the expiry time on later requests.
const verifiedTokens = new Map<string, { user: AuthUser; expiresAtMs: number }>();
const VERIFIED_TOKEN_CACHE_LIMIT = 50_000;

async function verifyToken(token: string): Promise<AuthUser> {
  const cached = verifiedTokens.get(token);
  if (cached && cached.expiresAtMs > Date.now()) return cached.user;

  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (!payload.sub || !payload.exp) throw new Error("token has no subject or expiry");
    const user: AuthUser = { id: payload.sub, role: payload.role === "admin" ? "admin" : "user" };

    if (verifiedTokens.size >= VERIFIED_TOKEN_CACHE_LIMIT) verifiedTokens.clear();
    verifiedTokens.set(token, { user, expiresAtMs: payload.exp * 1000 });
    return user;
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
