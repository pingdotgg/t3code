// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/** Codes start with this so a pasted code is recognizable and versioned. */
const CODE_PREFIX = "ctn1_";

export interface ShareCodePayload {
  /** Where the owner's relay answers, such as `http://100.64.0.2:3773`. */
  readonly endpoint: string;
  readonly grantId: string;
  readonly secret: string;
}

export function newGrantId(): string {
  return NodeCrypto.randomBytes(9).toString("base64url");
}

/** 256 bits from the OS generator. Only its hash is stored by the owner. */
export function newGrantSecret(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export function hashGrantSecret(secret: string): string {
  return NodeCrypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of a presented secret against the stored hash. */
export function grantSecretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashGrantSecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && NodeCrypto.timingSafeEqual(presented, stored);
}

export function encodeShareCode(payload: ShareCodePayload): string {
  const body = Buffer.from(
    JSON.stringify({ v: 1, e: payload.endpoint, g: payload.grantId, s: payload.secret }),
    "utf8",
  ).toString("base64url");
  return `${CODE_PREFIX}${body}`;
}

export function decodeShareCode(code: string): ShareCodePayload | null {
  const trimmed = code.trim().replace(/\s+/g, "");
  if (!trimmed.startsWith(CODE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(trimmed.slice(CODE_PREFIX.length), "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, e, g, s } = parsed as Record<string, unknown>;
    if (v !== 1 || typeof e !== "string" || typeof g !== "string" || typeof s !== "string") {
      return null;
    }
    const url = new URL(e);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(g) || !/^[A-Za-z0-9_-]{40,128}$/.test(s)) return null;
    return { endpoint: url.origin, grantId: g, secret: s };
  } catch {
    return null;
  }
}

/** The bearer token a recipient presents: `<grantId>.<secret>`. */
export function grantToken(payload: Pick<ShareCodePayload, "grantId" | "secret">): string {
  return `${payload.grantId}.${payload.secret}`;
}

export function parseGrantToken(
  header: string | null | undefined,
): { readonly grantId: string; readonly secret: string } | null {
  const raw = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  return { grantId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}
