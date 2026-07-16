import { pluginOperateScope, satisfiesScope } from "@t3tools/contracts";
import { PLUGIN_ID_PATTERN_SOURCE, type PluginId } from "@t3tools/contracts/plugin";
import type { PluginHttpResponse, PluginLogger } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { PluginHttpRegistry } from "./PluginHttpRegistry.ts";
import { makePluginLogger } from "./PluginLogger.ts";

const ROUTE_PREFIX = "/hooks/plugins";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Wall-clock ceiling for a single inbound plugin HTTP handler. Aligns with the
// 30s precedent used elsewhere in the plugin host (PluginHost registration
// timeout / HttpClientCapability default). An inbound route — especially a
// public webhook that remote callers can hit unauthenticated — must not let a
// hung handler (e.g. `Effect.never`) accumulate open requests indefinitely.
const PLUGIN_HTTP_HANDLER_TIMEOUT_MS = 30_000;
// Derive the inbound-route id gate from the same source the `PluginId` schema
// checks against, so the two can never drift: if they did, `HttpCapability`
// would hand a plugin a `basePath` this router rejects, 404-ing every webhook.
const PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`, "u");

function bodyLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(MAX_BODY_BYTES, Math.max(0, Math.floor(value)));
}

function parsePluginPath(pathname: string): {
  readonly pluginId: PluginId;
  readonly routePath: string;
} | null {
  if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return null;
  const suffix = pathname.slice(`${ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  const rawPluginId = separatorIndex === -1 ? suffix : suffix.slice(0, separatorIndex);
  if (!PLUGIN_ID_PATTERN.test(rawPluginId)) return null;
  const rest = separatorIndex === -1 ? "" : suffix.slice(separatorIndex + 1);
  return {
    pluginId: rawPluginId as PluginId,
    routePath: rest.length === 0 ? "/" : `/${rest}`,
  };
}

function requestQuery(url: URL): Readonly<Record<string, string | ReadonlyArray<string>>> {
  // Null-prototype: a query key named `__proto__` must be an own property, not
  // routed through the inherited accessor (which would mutate the prototype and
  // drop the value).
  const query: Record<string, string | Array<string>> = Object.create(null) as Record<
    string,
    string | Array<string>
  >;
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

const contentLength = (request: HttpServerRequest.HttpServerRequest): number | null => {
  const raw = request.headers["content-length"];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

class PluginHttpBodyTooLarge extends Schema.TaggedErrorClass<PluginHttpBodyTooLarge>()(
  "PluginHttpBodyTooLarge",
  { limit: Schema.Number },
) {}

// Read the body INCREMENTALLY with a hard cap: the content-length precheck
// is advisory (headers can lie, chunked bodies have none) — this is what
// actually bounds memory on public webhook routes.
const readBodyCapped = (request: HttpServerRequest.HttpServerRequest, maxBodyBytes: number) =>
  request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, total: 0 }),
      (acc, chunk: Uint8Array) => {
        const total = acc.total + chunk.byteLength;
        if (total > maxBodyBytes) {
          return Effect.fail(new PluginHttpBodyTooLarge({ limit: maxBodyBytes }));
        }
        acc.chunks.push(chunk);
        return Effect.succeed({ chunks: acc.chunks, total });
      },
    ),
    Effect.map(({ chunks, total }) => {
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    }),
  );

const authenticatePluginRoute = (pluginId: PluginId) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    const requiredScope = pluginOperateScope(pluginId);
    if (!satisfiesScope(requiredScope, session.scopes)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
  });

// Response headers a plugin must never be able to set on the host origin: they
// carry ambient privilege over the host's browser security context (session,
// redirect, auth challenge, CORS). A mistaken — or public — route setting any
// of these would hijack host session/caching, so they are stripped; everything
// else (content-type, cache-control, etag, content-disposition, x-*) passes.
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "location",
  "www-authenticate",
  "proxy-authenticate",
  // `clear-site-data` wipes host-origin cookies/storage/cache; `refresh` drives a
  // client-side navigation the same way `location` does. Both carry the same
  // ambient-privilege boundary as the rest of the list, so a plugin route must
  // not be able to set them either.
  "clear-site-data",
  "refresh",
]);
const FORBIDDEN_RESPONSE_HEADER_PREFIXES = ["access-control-"];

const sanitizeResponseHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) continue;
    if (FORBIDDEN_RESPONSE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    sanitized[key] = value;
  }
  return sanitized;
};

// Clamp to the valid HTTP status range: a plugin returns an arbitrary number,
// and an out-of-range value would otherwise become a malformed wire status.
const clampStatus = (status: number): number =>
  Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500;

function toHttpResponse(response: PluginHttpResponse): HttpServerResponse.HttpServerResponse {
  const options = {
    status: clampStatus(response.status),
    ...(response.headers === undefined
      ? {}
      : { headers: sanitizeResponseHeaders(response.headers) }),
  };
  const body = response.body;
  if (body === undefined || body === null) {
    return HttpServerResponse.empty(options);
  }
  if (body instanceof Uint8Array) {
    return HttpServerResponse.uint8Array(body, options);
  }
  if (typeof body === "string") {
    return HttpServerResponse.text(body, options);
  }
  return HttpServerResponse.jsonUnsafe(body, options);
}

// Re-raise an interrupt-only cause without widening the typed error channel:
// `Cause.hasInterruptsOnly` guarantees the cause carries no failures/defects, so
// narrowing to `Cause<never>` is sound.
const propagateInterrupt = (cause: Cause.Cause<unknown>): Effect.Effect<never> =>
  Effect.failCause(cause as Cause.Cause<never>);

// A handler — or the surrounding route — that is interrupted (client disconnect,
// server/plugin-scope shutdown) must PROPAGATE cancellation, not get logged as a
// failure and answered with a 500 to a dead socket. Convert only genuine
// failures/defects into a 500; re-raise interrupt-only causes.
export const respondToPluginHandlerExit = (
  exit: Exit.Exit<PluginHttpResponse, Error>,
  logger: PluginLogger,
  context: { readonly method: string; readonly path: string },
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed(toHttpResponse(exit.value));
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return propagateInterrupt(exit.cause);
  }
  return logger
    .error("plugin http handler failed", {
      method: context.method,
      path: context.path,
      cause: Cause.pretty(exit.cause),
    })
    .pipe(Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })));
};

export interface PluginHttpRouteOptions {
  // Injectable so tests can drive the deadline branch with a short value; the
  // default is the 30s production ceiling.
  readonly handlerTimeoutMs?: number;
}

export const makePluginHttpRouteLayer = (options: PluginHttpRouteOptions = {}) => {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? PLUGIN_HTTP_HANDLER_TIMEOUT_MS;
  return HttpRouter.add(
    "*",
    `${ROUTE_PREFIX}/*`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      const parsed = parsePluginPath(url.value.pathname);
      if (!parsed) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      const registry = yield* PluginHttpRegistry;
      const matched = yield* registry.match({
        pluginId: parsed.pluginId,
        method: request.method,
        path: parsed.routePath,
      });
      if (Option.isNone(matched)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      const { descriptor, params } = matched.value;
      // Fail closed: authenticate UNLESS the descriptor explicitly opts out with
      // the exact literal "public". Descriptors come from dynamically loaded plugin
      // JS where the SDK's `"public" | "token"` type is not runtime-enforced, so an
      // unrecognized value (undefined, a casing typo like "Token", or "") must
      // require a token rather than serve openly — mirroring the scope handling in
      // authorizeDescriptor (PluginRpcDispatcher.ts).
      if (descriptor.auth !== "public") {
        yield* authenticatePluginRoute(parsed.pluginId);
      }

      const maxBodyBytes = bodyLimit(descriptor.maxBodyBytes);
      const declaredLength = contentLength(request);
      if (declaredLength !== null && declaredLength > maxBodyBytes) {
        return HttpServerResponse.text("Payload Too Large", { status: 413 });
      }

      const logger = makePluginLogger(parsed.pluginId);
      const handlerContext = { method: request.method, path: parsed.routePath };

      // A single wall-clock deadline spans BOTH body ingestion and handler
      // execution. Wrapping only the handler left the pre-handler body read
      // unbounded: a caller to a public route could drip the request body
      // indefinitely (staying under `maxBodyBytes`) so the handler timeout never
      // started, and the request fiber — and its socket — stayed open until the
      // client chose to finish. Bounding the read as well closes that slow-body
      // resource-exhaustion vector. On timeout the fiber is interrupted and we
      // answer 504, deliberately bypassing the 500 failure mapping.
      return yield* Effect.gen(function* () {
        const bodyOutcome = yield* readBodyCapped(request, maxBodyBytes).pipe(
          Effect.map((body) => ({ kind: "ok" as const, body })),
          Effect.catch((error) =>
            Effect.succeed({
              kind: "rejected" as const,
              response:
                (error as { readonly _tag?: string })._tag === "PluginHttpBodyTooLarge"
                  ? HttpServerResponse.text("Payload Too Large", { status: 413 })
                  : HttpServerResponse.text("Bad Request", { status: 400 }),
            }),
          ),
        );
        if (bodyOutcome.kind === "rejected") {
          return bodyOutcome.response;
        }

        const exit = yield* descriptor
          .handler(
            {
              method: request.method,
              params,
              query: requestQuery(url.value),
              headers: request.headers,
              body: bodyOutcome.body,
            },
            { pluginId: parsed.pluginId, logger },
          )
          .pipe(Effect.exit);
        return yield* respondToPluginHandlerExit(exit, logger, handlerContext);
      }).pipe(
        Effect.timeoutOrElse({
          duration: handlerTimeoutMs,
          orElse: () =>
            logger
              .error("plugin http request timed out", {
                ...handlerContext,
                timeoutMs: handlerTimeoutMs,
              })
              .pipe(Effect.as(HttpServerResponse.text("Gateway Timeout", { status: 504 }))),
        }),
      );
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
      Effect.catchCause((cause) =>
        // A cancelled request (client disconnect / scope shutdown) interrupts the
        // whole route: propagate it rather than logging + 500-ing a dead socket.
        Cause.hasInterruptsOnly(cause)
          ? propagateInterrupt(cause)
          : Effect.logWarning("plugin http route failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
            ),
      ),
    ),
  );
};

export const pluginHttpRouteLayer = makePluginHttpRouteLayer();
