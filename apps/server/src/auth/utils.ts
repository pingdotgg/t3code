import type {
  AuthClientMetadata,
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "t3_session";

/** Cookies span ports; use separate names for servers sharing a hostname. */
export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly environmentId: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(
      !input.development && isRemoteReachableHost(input.host)
        ? input.environmentId
        : input.instanceKey,
    )
    .digest("hex")
    .slice(0, 12);

  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function resolveLegacySessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
  readonly development: boolean;
}): string | undefined {
  return input.mode === "web" && !input.development && isRemoteReachableHost(input.host)
    ? SESSION_COOKIE_NAME
    : undefined;
}

/**
 * The loopback address a server given `host` listens on, or undefined when it may listen beyond
 * this machine. Unset means 127.0.0.1. Only a loopback literal or `localhost` counts: Node listens
 * on every interface for an empty host, and any other name resolves through DNS.
 */
export function loopbackBindAddress(host: string | undefined): string | undefined {
  if (host === undefined) return "127.0.0.1";
  const address = normalizeHostname(host);
  if (address === "localhost") return "127.0.0.1";
  return (NodeNet.isIPv4(address) && address.startsWith("127.")) || address === "::1"
    ? address
    : undefined;
}

export const isRemoteReachableHost = (host: string | undefined): boolean =>
  loopbackBindAddress(host) === undefined;

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Base64Url.encode(new TextEncoder().encode(input))
    : Base64Url.encode(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Base64Url.decodeString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  if (!userAgent) {
    return "unknown";
  }

  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) {
    return "bot";
  }
  if (/ipad|tablet/.test(normalized)) {
    return "tablet";
  }
  if (/iphone|android.+mobile|mobile/.test(normalized)) {
    return "mobile";
  }
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/edg(?:e|a|ios)?\//.test(normalized)) return "Edge";
  if (/opr\/|opios\//.test(normalized)) return "Opera";
  if (/firefox\/|fxios\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

function readRemoteAddressFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };

  return normalizeIpAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

export function deriveAuthClientMetadata(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presented?: AuthClientPresentationMetadata;
}): AuthClientMetadata {
  const userAgent = normalizeNonEmptyString(input.request.headers["user-agent"]);
  const ipAddress = readRemoteAddressFromSource(input.request.source);
  const os = input.presented?.os ?? inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    ...(input.presented?.label ? { label: input.presented.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: input.presented?.deviceType ?? inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
  };
}
