import { pluginOperateScope, satisfiesScope } from "@t3tools/contracts";
import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginHttpResponse } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/u;

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
  const query: Record<string, string | Array<string>> = {};
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

function toHttpResponse(response: PluginHttpResponse): HttpServerResponse.HttpServerResponse {
  const options = {
    status: response.status,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
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

export const pluginHttpRouteLayer = HttpRouter.add(
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
    if (descriptor.auth === "token") {
      yield* authenticatePluginRoute(parsed.pluginId);
    }

    const maxBodyBytes = bodyLimit(descriptor.maxBodyBytes);
    const declaredLength = contentLength(request);
    if (declaredLength !== null && declaredLength > maxBodyBytes) {
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }

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
    const body = bodyOutcome.body;

    const logger = makePluginLogger(parsed.pluginId);
    const exit = yield* descriptor
      .handler(
        {
          method: request.method,
          params,
          query: requestQuery(url.value),
          headers: request.headers,
          body,
        },
        { pluginId: parsed.pluginId, logger },
      )
      .pipe(Effect.exit);

    if (exit._tag === "Failure") {
      yield* logger.error("plugin http handler failed", {
        method: request.method,
        path: parsed.routePath,
        cause: Cause.pretty(exit.cause),
      });
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return toHttpResponse(exit.value);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("plugin http route failed", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    ),
  ),
);
