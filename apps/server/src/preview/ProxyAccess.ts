/**
 * Preview proxy access - tickets and cookie sessions for the remote dev-server
 * preview.
 *
 * A paired client (the mobile WebView) cannot attach bearer headers to
 * subresource requests, so access works like asset URLs: the server mints a
 * signed, single-use entry ticket over the authenticated WebSocket, the client
 * navigates to the entry path, and the server exchanges the ticket for an
 * HttpOnly session cookie that authorizes the proxy for the rest of the
 * browsing session. Claims pin the environment id and the validated
 * host-local port, so a ticket cannot be replayed against another environment
 * or redirected to an arbitrary port.
 */
import { PREVIEW_PROXY_EXIT_PATH, PreviewProxyTicketError } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "./PortScanner.ts";

export const PREVIEW_PROXY_ROUTE_PREFIX = "/api/preview";
export const PREVIEW_PROXY_ENTRY_PREFIX = `${PREVIEW_PROXY_ROUTE_PREFIX}/enter`;
export { PREVIEW_PROXY_EXIT_PATH };
export const PREVIEW_PROXY_COOKIE_NAME = "t3_preview_proxy";

const SIGNING_SECRET_NAME = "preview-proxy-signing-key";
const ENTRY_TICKET_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const ProxyClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("entry"),
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
    ticketId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("session"),
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
    expiresAt: Schema.Number,
  }),
]);
type ProxyClaims = typeof ProxyClaimsSchema.Type;
export type ProxySessionClaims = Extract<ProxyClaims, { kind: "session" }>;

const ProxyClaimsJson = Schema.fromJsonString(ProxyClaimsSchema);
const decodeProxyClaims = Schema.decodeUnknownOption(ProxyClaimsJson);
const encodeProxyClaims = Schema.encodeSync(ProxyClaimsJson);

/**
 * Entry tickets are single use. Redeemed ticket ids are held in memory until
 * they would have expired anyway; a server restart forgets them, but a
 * restart also rotates nothing the ticket could still be replayed against
 * inside its two-minute window beyond what a fresh mint would grant.
 */
const consumedEntryTickets = new Map<string, number>();

function pruneConsumedTickets(now: number): void {
  for (const [ticketId, expiresAt] of consumedEntryTickets) {
    if (expiresAt <= now) {
      consumedEntryTickets.delete(ticketId);
    }
  }
}

const loadSigningSecret = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((secretStore) => secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32)),
);

function decodeToken(token: string, secret: Uint8Array): ProxyClaims | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) return null;
  try {
    return Option.getOrNull(decodeProxyClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function encodeToken(claims: ProxyClaims, secret: Uint8Array): string {
  const encodedPayload = base64UrlEncode(encodeProxyClaims(claims));
  return `${encodedPayload}.${signPayload(encodedPayload, secret)}`;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export const issueProxyTicket = Effect.fn("PreviewProxyAccess.issueProxyTicket")(function* (input: {
  readonly url: string;
}) {
  const parsed = parseUrl(input.url);
  if (parsed === null) {
    return yield* new PreviewProxyTicketError({ reason: "invalid-url" });
  }
  if (parsed.protocol !== "http:") {
    return yield* new PreviewProxyTicketError({ reason: "invalid-url" });
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return yield* new PreviewProxyTicketError({ reason: "not-local" });
  }
  const port = Number(parsed.port || "80");

  // Only ports the scanner classified as host-local web servers are
  // proxyable; the ticket pins the discovered host so the proxy never
  // connects anywhere the environment did not already expose locally.
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const servers = yield* portDiscovery.scan([input.url]);
  const server = servers.find(
    (candidate) => candidate.port === port && isLoopbackHost(candidate.host),
  );
  if (!server) {
    return yield* new PreviewProxyTicketError({ reason: "not-discovered" });
  }

  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const crypto = yield* Crypto.Crypto;
  const ticketId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => new PreviewProxyTicketError({ reason: "issuance-failed" })),
  );
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + ENTRY_TICKET_TTL_MS;
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError(() => new PreviewProxyTicketError({ reason: "issuance-failed" })),
  );
  const token = encodeToken(
    {
      version: 1,
      kind: "entry",
      environmentId,
      host: server.host,
      port: server.port,
      ticketId,
      expiresAt,
    },
    secret,
  );
  return { entryPath: `${PREVIEW_PROXY_ENTRY_PREFIX}/${token}`, expiresAt };
});

export type EntryRedemption =
  | {
      readonly ok: true;
      readonly cookieValue: string;
      readonly claims: ProxySessionClaims;
    }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "expired" | "reused" | "cross-environment";
    };

/** Exchange a single-use entry ticket for a signed session cookie value. */
export const redeemEntryTicket = Effect.fn("PreviewProxyAccess.redeemEntryTicket")(function* (
  token: string,
) {
  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the preview proxy signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret) return { ok: false, reason: "malformed" } satisfies EntryRedemption;
  const claims = decodeToken(token, secret);
  if (!claims || claims.kind !== "entry") {
    return { ok: false, reason: "malformed" } satisfies EntryRedemption;
  }
  const now = yield* Clock.currentTimeMillis;
  pruneConsumedTickets(now);
  if (claims.expiresAt <= now) {
    return { ok: false, reason: "expired" } satisfies EntryRedemption;
  }
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  if (claims.environmentId !== environmentId) {
    return { ok: false, reason: "cross-environment" } satisfies EntryRedemption;
  }
  if (consumedEntryTickets.has(claims.ticketId)) {
    return { ok: false, reason: "reused" } satisfies EntryRedemption;
  }
  consumedEntryTickets.set(claims.ticketId, claims.expiresAt);

  const sessionClaims: ProxySessionClaims = {
    version: 1,
    kind: "session",
    environmentId: claims.environmentId,
    host: claims.host,
    port: claims.port,
    expiresAt: now + SESSION_TTL_MS,
  };
  return {
    ok: true,
    cookieValue: encodeToken(sessionClaims, secret),
    claims: sessionClaims,
  } satisfies EntryRedemption;
});

/** Validate a preview session cookie. Returns the claims or null. */
export const verifySessionCookie = Effect.fn("PreviewProxyAccess.verifySessionCookie")(function* (
  cookieValue: string,
) {
  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the preview proxy signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret) return null;
  const claims = decodeToken(cookieValue, secret);
  if (!claims || claims.kind !== "session") return null;
  const now = yield* Clock.currentTimeMillis;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  if (claims.expiresAt <= now || claims.environmentId !== environmentId) return null;
  return claims;
});
