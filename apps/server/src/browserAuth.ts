import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { Effect, FileSystem, Layer, Path, Ref, Schema, ServiceMap } from "effect";

import { ServerConfig, type ServerConfigShape } from "./config";

const BOOTSTRAP_TOKEN_TTL_MS = 5 * 60 * 1_000;
const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const AUTH_COOKIE_NAME = "t3_auth";
const BOOTSTRAP_HASH_KEY = "t3_bootstrap";
const COOKIE_SECRET_FILENAME = "browser-auth-secret";

interface BootstrapState {
  readonly token: string;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

interface AuthCookiePayload {
  readonly v: 1;
  readonly purpose: "browser-auth";
  readonly iat: number;
  readonly exp: number;
}

export class BrowserAuthError extends Schema.TaggedErrorClass<BrowserAuthError>()(
  "BrowserAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface BrowserAuthShape {
  readonly getPairingUrl: (baseUrl: string) => Effect.Effect<string, never>;
  readonly getAllowedOrigins: Effect.Effect<ReadonlySet<string>, never>;
  readonly isAllowedOrigin: (origin: string | undefined) => Effect.Effect<boolean, never>;
  readonly consumeBootstrapToken: (token: string) => Effect.Effect<boolean, never>;
  readonly isAuthenticatedRequest: (headers: IncomingHttpHeaders) => Effect.Effect<boolean, never>;
  readonly createAuthCookie: (isSecure: boolean) => Effect.Effect<string, never>;
}

export class BrowserAuth extends ServiceMap.Service<BrowserAuth, BrowserAuthShape>()(
  "t3/browserAuth",
) {}

function makeBootstrapToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function makeCookieSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signCookie(payload: AuthCookiePayload, secret: string): string {
  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
  return `${payloadEncoded}.${signature}`;
}

function verifyCookie(cookie: string, secret: string, now = Date.now()): boolean {
  const separatorIndex = cookie.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= cookie.length - 1) {
    return false;
  }

  const payloadEncoded = cookie.slice(0, separatorIndex);
  const providedSignature = cookie.slice(separatorIndex + 1);
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");

  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadEncoded)) as Partial<AuthCookiePayload>;
    if (parsed.v !== 1 || parsed.purpose !== "browser-auth") {
      return false;
    }
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
      return false;
    }
    return parsed.exp > now;
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | string[] | undefined): Map<string, string> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!raw) return new Map();

  const cookies = new Map<string, string>();
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    cookies.set(key, value);
  }
  return cookies;
}

function normalizeOriginSet(serverConfig: ServerConfigShape): ReadonlySet<string> {
  const origins = new Set<string>();
  origins.add(`http://localhost:${serverConfig.port}`);
  origins.add(`http://127.0.0.1:${serverConfig.port}`);
  origins.add(`http://[::1]:${serverConfig.port}`);

  if (
    serverConfig.host &&
    serverConfig.host !== "0.0.0.0" &&
    serverConfig.host !== "::" &&
    serverConfig.host !== "[::]"
  ) {
    const host =
      serverConfig.host.includes(":") && !serverConfig.host.startsWith("[")
        ? `[${serverConfig.host}]`
        : serverConfig.host;
    origins.add(`http://${host}:${serverConfig.port}`);
  }

  if (serverConfig.devUrl) {
    origins.add(serverConfig.devUrl.origin);
  }

  return origins;
}

function formatAuthCookie(cookieValue: string, isSecure: boolean): string {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${cookieValue}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (isSecure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

export const BrowserAuthLive = Layer.effect(
  BrowserAuth,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cookieSecretPath = path.join(serverConfig.stateDir, COOKIE_SECRET_FILENAME);

    const existingSecret = yield* fileSystem
      .readFileString(cookieSecretPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const cookieSecret =
      existingSecret && existingSecret.trim().length > 0
        ? existingSecret.trim()
        : makeCookieSecret();

    if (existingSecret === null || existingSecret.trim().length === 0) {
      yield* fileSystem.makeDirectory(path.dirname(cookieSecretPath), { recursive: true });
      yield* fileSystem.writeFileString(cookieSecretPath, `${cookieSecret}\n`);
    }

    const bootstrapState = yield* Ref.make<BootstrapState>({
      token: makeBootstrapToken(),
      expiresAt: Date.now() + BOOTSTRAP_TOKEN_TTL_MS,
      consumedAt: null,
    });
    const allowedOrigins = normalizeOriginSet(serverConfig);

    const getPairingUrl: BrowserAuthShape["getPairingUrl"] = (baseUrl) =>
      Ref.get(bootstrapState).pipe(
        Effect.map((state) => {
          const target = new URL(baseUrl);
          target.hash = `${BOOTSTRAP_HASH_KEY}=${state.token}`;
          return target.toString();
        }),
      );

    const isAllowedOrigin: BrowserAuthShape["isAllowedOrigin"] = (origin) =>
      Effect.succeed(typeof origin === "string" && allowedOrigins.has(origin));

    const consumeBootstrapToken: BrowserAuthShape["consumeBootstrapToken"] = (token) =>
      Ref.modify(bootstrapState, (state) => {
        const now = Date.now();
        const matches =
          token.length > 0 &&
          state.consumedAt === null &&
          state.expiresAt > now &&
          state.token === token;
        return [matches, matches ? { ...state, consumedAt: now } : state] as const;
      });

    const isAuthenticatedRequest: BrowserAuthShape["isAuthenticatedRequest"] = (headers) =>
      Effect.succeed(
        verifyCookie(parseCookies(headers.cookie).get(AUTH_COOKIE_NAME) ?? "", cookieSecret),
      );

    const createAuthCookie: BrowserAuthShape["createAuthCookie"] = (isSecure) =>
      Effect.succeed(
        formatAuthCookie(
          signCookie(
            {
              v: 1,
              purpose: "browser-auth",
              iat: Date.now(),
              exp: Date.now() + AUTH_COOKIE_MAX_AGE_SECONDS * 1_000,
            },
            cookieSecret,
          ),
          isSecure,
        ),
      );

    return {
      getPairingUrl,
      getAllowedOrigins: Effect.succeed(allowedOrigins),
      isAllowedOrigin,
      consumeBootstrapToken,
      isAuthenticatedRequest,
      createAuthCookie,
    } satisfies BrowserAuthShape;
  }),
);
