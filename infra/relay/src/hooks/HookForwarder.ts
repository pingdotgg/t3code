import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayApi, type RelayHookDeliveryProofPayload } from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HOOK_DELIVERY_HEADER,
  RELAY_HOOK_DELIVERY_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";

import * as RelayConfiguration from "../Config.ts";
import { MANAGED_ENDPOINT_KEY_PATTERN } from "../deploymentConfig.ts";
import * as HeldHooks from "./HeldHooks.ts";
import * as HookInbox from "./HookInbox.ts";
import { sendUpstream, TUNNEL_OFFLINE_STATUS } from "./upstream.ts";

export const RELAY_HOOK_PATH_PREFIX = "/v1/hooks/";
export const RELAY_HOOK_MAX_BODY_BYTES = 1_048_576;
export const RELAY_HOOK_RATE_LIMIT = { limit: 60, periodSeconds: 60 } as const;
/**
 * Hook budgets are per URL, and a sender who knows an endpoint key can mint
 * new URLs for free, so every endpoint also has one overall budget.
 */
export const RELAY_HOOK_ENDPOINT_RATE_LIMIT = { limit: 600, periodSeconds: 60 } as const;
/**
 * Upstream statuses that mean the environment did not take the request: the
 * tunnel has no origin (530) or cloudflared cannot reach the local server
 * (502, 503, 504) while it restarts.
 */
export const ENVIRONMENT_UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([
  502,
  503,
  504,
  TUNNEL_OFFLINE_STATUS,
]);

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "content-length",
  "cookie",
  "x-real-ip",
  // Only the relay may set this; a sender could otherwise collide delivery ids.
  "x-t3-relay-delivery-id",
  "x-t3-relay-received-at",
  RELAY_HOOK_DELIVERY_HEADER,
  // The environment trusts trace context only from the relay, which sets its own.
  "traceparent",
  "tracestate",
  "b3",
]);
const DROPPED_REQUEST_HEADER_PREFIXES = ["proxy-", "cf-", "x-forwarded-", "x-b3-"];

export const isRelayHookPath = (url: string): boolean => url.startsWith(RELAY_HOOK_PATH_PREFIX);

/** Replaces the hook token (and any query) so traces and logs never record the secret. */
export const redactRelayHookUrl = (url: string): string => {
  const path = url.split("?", 1)[0] ?? url;
  const segments = path.split("/");
  if (segments.length >= 6) {
    segments[5] = "<redacted>";
  }
  return segments.join("/");
};

/**
 * Request budget for public hook forwarding, keyed by a hash of the hook URL
 * (endpoint, hook and token). Requests with a wrong token get their own
 * budget, so they cannot use up a real sender's; the environment rejects them.
 * Built from decoded segments, because the environment decodes them too: two
 * spellings of one token (`token`, `%74oken`) must share one budget.
 */
const hookBudgetKey = (hook: {
  readonly endpointKey: string;
  readonly hookId: string;
  readonly token: string;
}) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      // Length-prefixed, so no segment contents can make two keys collide.
      new TextEncoder().encode(
        [hook.endpointKey, hook.hookId, hook.token]
          .map((part) => `${part.length}:${part}`)
          .join(""),
      ),
    ),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export class HookRateLimiter extends Context.Service<
  HookRateLimiter,
  {
    /** One hook URL's budget, keyed by `hookBudgetKey`. */
    readonly allowHook: (key: string) => Effect.Effect<boolean>;
    /** One endpoint's overall budget, keyed by its endpoint key. */
    readonly allowEndpoint: (endpointKey: string) => Effect.Effect<boolean>;
  }
>()("t3code-relay/hooks/HookForwarder/HookRateLimiter") {}

export class HookForwarder extends Context.Service<
  HookForwarder,
  {
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/hooks/HookForwarder") {}

class HookBodyTooLarge extends Schema.TaggedError<HookBodyTooLarge>()("HookBodyTooLarge", {}) {}

const errorResponse = (status: number, error: string, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, ...(headers ? { headers } : {}) });

const hookNotFound = () => errorResponse(404, "hook_not_found");

/** Longer than the inbox holds a request, so a held delivery's proof still verifies. */
const DELIVERY_PROOF_LIFETIME_SECONDS = 25 * 60 * 60;

const signDeliveryProof = (input: {
  readonly settings: RelayConfiguration.RelayConfiguration["Service"];
  readonly environmentId: string;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly hookId: string;
  readonly jti: string;
}) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    return yield* signRelayJwt({
      privateKey: Redacted.value(input.settings.cloudMintPrivateKey),
      typ: RELAY_HOOK_DELIVERY_TYP,
      payload: {
        iss: normalizeRelayIssuer(input.settings.relayIssuer),
        aud: `t3-env:${input.environmentId}`,
        sub: input.environmentId,
        jti: input.jti,
        iat: now,
        exp: now + DELIVERY_PROOF_LIFETIME_SECONDS,
        environmentId: EnvironmentId.make(input.environmentId),
        deliveryId: input.deliveryId,
        receivedAt: input.receivedAt,
        hookId: input.hookId,
      } satisfies RelayHookDeliveryProofPayload,
    });
  }).pipe(Effect.orDie);

/** Methods a webhook can arrive with; HEAD reaches the GET route and is refused. */
const FORWARDED_METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);

/**
 * Whatever the environment answers is served from the relay's own origin, so
 * a body must never render or run there.
 */
const SANDBOXED_RESPONSE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
} as const;

function parseHookPath(url: string) {
  const queryIndex = url.indexOf("?");
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : url.slice(queryIndex);
  const segments = path.split("/");
  // ["", "v1", "hooks", endpointKey, hookId, token]
  if (segments.length !== 6) return null;
  const [, , , endpointKey, rawHookId, rawToken] = segments;
  if (!endpointKey || !MANAGED_ENDPOINT_KEY_PATTERN.test(endpointKey) || !rawHookId || !rawToken) {
    return null;
  }
  try {
    return {
      endpointKey,
      hookId: decodeURIComponent(rawHookId),
      token: decodeURIComponent(rawToken),
      // Forward the encoded segments byte-for-byte; the environment decodes them.
      rawHookId,
      rawToken,
      search,
    };
  } catch {
    return null;
  }
}

function forwardedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  // Headers the sender names in Connection are hop-by-hop too (RFC 9110 7.6.1).
  const connectionValue =
    Object.entries(headers).find(([name]) => name.toLowerCase() === "connection")?.[1] ?? "";
  const nominated = new Set(
    connectionValue
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const name in headers) {
    const lower = name.toLowerCase();
    if (
      DROPPED_REQUEST_HEADERS.has(lower) ||
      nominated.has(lower) ||
      DROPPED_REQUEST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      continue;
    }
    const value = headers[name];
    if (value !== undefined) result[lower] = value;
  }
  return result;
}

const hasNoBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof Request && request.source.body === null;

const readCappedBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.suspend(() => {
    if (hasNoBody(request)) {
      return Effect.succeed(new Uint8Array(0));
    }
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return request.stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.length;
        if (total > RELAY_HOOK_MAX_BODY_BYTES) {
          return Effect.fail(new HookBodyTooLarge());
        }
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.map(() => {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return body;
      }),
    );
  });

const make = Effect.gen(function* () {
  const heldHooks = yield* HeldHooks.HeldHooks;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const rateLimiter = yield* HookRateLimiter;
  const inbox = yield* HookInbox.HookInbox;
  const crypto = yield* Crypto.Crypto;

  const handle = Effect.fn("relay.hooks.forward")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const outcome = (value: string) => Effect.annotateCurrentSpan({ "relay.hook.outcome": value });
    if (!FORWARDED_METHODS.has(request.method)) {
      yield* outcome("method_not_allowed");
      return errorResponse(405, "method_not_allowed", { allow: "GET, POST, PUT, PATCH" });
    }
    // When the sender called, not when the environment failed to answer.
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const parsed = parseHookPath(request.url);
    if (!parsed) {
      yield* outcome("invalid_path");
      return hookNotFound();
    }
    yield* Effect.annotateCurrentSpan({
      "relay.hook.endpoint_key": parsed.endpointKey,
      "relay.hook_id": parsed.hookId,
    });
    // A coarse budget per endpoint first, so minting new hook ids or tokens
    // cannot buy unlimited lookups and forwards, or fill the inbox.
    const endpointAllowed = yield* rateLimiter.allowEndpoint(parsed.endpointKey);
    const hookAllowed =
      endpointAllowed && (yield* rateLimiter.allowHook(yield* hookBudgetKey(parsed)));
    if (!endpointAllowed || !hookAllowed) {
      // Which budget ran out: the whole endpoint's, or this one hook URL's.
      yield* Effect.annotateCurrentSpan({
        "relay.hook.rate_limit": endpointAllowed ? "hook" : "endpoint",
      });
      yield* outcome("rate_limited");
      return errorResponse(429, "rate_limited", {
        "retry-after": String(RELAY_HOOK_RATE_LIMIT.periodSeconds),
      });
    }
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > RELAY_HOOK_MAX_BODY_BYTES) {
      yield* outcome("payload_too_large");
      return errorResponse(413, "payload_too_large");
    }

    const endpoint = yield* heldHooks.resolveEndpoint(parsed.endpointKey).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to resolve hook endpoint", {
          endpointKey: parsed.endpointKey,
          errorTag: error._tag,
        }).pipe(Effect.as(null)),
      ),
    );
    if (!endpoint) {
      yield* outcome("not_found");
      return hookNotFound();
    }
    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": endpoint.environmentId,
      "relay.hook.hold_while_offline": endpoint.holdWhileOffline,
    });

    const body =
      request.method === "GET"
        ? Result.succeed(new Uint8Array(0))
        : yield* readCappedBody(request).pipe(Effect.result);
    if (Result.isFailure(body)) {
      if (body.failure._tag === "HookBodyTooLarge") {
        yield* outcome("payload_too_large");
        return errorResponse(413, "payload_too_large");
      }
      yield* outcome("invalid_body");
      return errorResponse(400, "invalid_body");
    }

    // One id per request, so a request that reached the environment before a
    // timeout and is later delivered from the inbox runs only once.
    yield* Effect.annotateCurrentSpan({ "relay.hook.body_bytes": body.success.byteLength });
    const deliveryId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    // Proves to the environment that this delivery id, receive time and
    // trace context came from the relay. Signed once here and stored with a
    // held request, so the inbox never needs the signing key.
    const proof = yield* signDeliveryProof({
      settings,
      environmentId: endpoint.environmentId,
      deliveryId,
      receivedAt,
      hookId: parsed.hookId,
      jti: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    });
    const hook = {
      id: deliveryId,
      receivedAt,
      method: request.method,
      rawHookId: parsed.rawHookId,
      rawToken: parsed.rawToken,
      hookKey: parsed.hookId,
      query: parsed.search.replace(/^\?/, ""),
      headers: { ...forwardedHeaders(request.headers), [RELAY_HOOK_DELIVERY_HEADER]: proof },
      body: body.success,
    };
    // Held only for environments that opted in; otherwise the relay is a plain proxy.
    const holdOrFail = (status: 503 | 504, error: string) =>
      Effect.gen(function* () {
        if (!endpoint.holdWhileOffline) {
          yield* outcome(error);
          return errorResponse(status, error);
        }
        const stored = yield* inbox
          .hold({
            endpointKey: parsed.endpointKey,
            baseUrl: endpoint.httpBaseUrl,
            hook,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not hold webhook request", {
                environmentId: endpoint.environmentId,
                errorTag: cause._tag,
              }).pipe(Effect.as(null)),
            ),
          );
        if (stored === null) {
          yield* outcome(error);
          return errorResponse(status, error);
        }
        if (!stored) {
          // The inbox span carries which cap refused it (relay.inbox.refused).
          yield* outcome("inbox_full");
          return errorResponse(503, "inbox_full");
        }
        yield* outcome("held");
        return HttpServerResponse.jsonUnsafe({ queued: true }, { status: 202 });
      });

    const upstream = yield* sendUpstream(endpoint.httpBaseUrl, hook).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.result,
    );
    if (Result.isFailure(upstream)) {
      yield* Effect.annotateCurrentSpan({ "relay.hook.upstream_error": upstream.failure._tag });
      return yield* holdOrFail(503, "environment_unavailable");
    }
    if (Option.isNone(upstream.success)) {
      return yield* holdOrFail(504, "environment_timeout");
    }
    const response = upstream.success.value;
    if (ENVIRONMENT_UNREACHABLE_STATUSES.has(response.status)) {
      yield* Effect.annotateCurrentSpan({ "relay.hook.upstream_status": response.status });
      return yield* holdOrFail(503, "environment_unavailable");
    }
    yield* Effect.annotateCurrentSpan({
      "relay.hook.outcome": "forwarded",
      "relay.hook.upstream_status": response.status,
      ...(response.outcome === undefined
        ? {}
        : { "relay.hook.upstream_outcome": response.outcome }),
    });
    // Only content-type is passed through: no location (redirects are never
    // followed or relayed), no cookies, no upstream infrastructure headers.
    const headers = {
      ...SANDBOXED_RESPONSE_HEADERS,
      ...(response.contentType ? { "content-type": response.contentType } : {}),
    };
    if (response.body.length === 0) {
      return HttpServerResponse.empty({ status: response.status, headers });
    }
    return HttpServerResponse.uint8Array(response.body, {
      status: response.status,
      headers,
      ...(response.contentType ? { contentType: response.contentType } : {}),
    });
  });

  return HookForwarder.of({ handle });
});

export const layer = Layer.effect(HookForwarder, make);

/**
 * Implements the RelayApi `hooks` group. The endpoints are raw: the forwarder
 * re-reads the encoded path segments from the request so the token and hook
 * id reach the environment byte for byte, and streams the body itself.
 */
export const hooksApi = HttpApiBuilder.group(
  RelayApi,
  "hooks",
  Effect.fnUntraced(function* (handlers) {
    const forwarder = yield* HookForwarder;
    const forward = ({ request }: { readonly request: HttpServerRequest.HttpServerRequest }) =>
      forwarder.handle(request);
    return handlers
      .handleRaw("forwardPost", forward)
      .handleRaw("forwardPut", forward)
      .handleRaw("forwardPatch", forward)
      .handleRaw("forwardGet", forward);
  }),
);
