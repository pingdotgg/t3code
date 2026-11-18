import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeZlib from "node:zlib";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { InferenceProxy } from "./InferenceProxy.ts";
import { inferenceRetryDelayMs, inferenceTarget, isRetryableInferenceStatus } from "./routes.ts";

const MAX_REPLAY_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const decodeErrorJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const isProviderError = Schema.is(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
);
const MAX_CATALOG_BODY_BYTES = 1024 * 1024;
const MAX_CATALOG_UNION_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_MODELS = 4096;
const MAX_SESSION_ROUTES = 1024;
const SESSION_ROUTE_TTL_MS = 30 * 60 * 1000;
const sessionRoutes = new Map<string, { hostId: string; expiresAt: number }>();

class InferenceStreamError extends Schema.TaggedError<InferenceStreamError>()(
  "InferenceStreamError",
  { cause: Schema.Unknown },
) {}

function sessionRouteKey(
  key: string,
  driver: string | undefined,
  model: string | undefined,
  session: string | undefined,
): string | undefined {
  if (!driver || !model || !session || session.length > 256) return undefined;
  return JSON.stringify([key, driver, model, session]);
}

function rememberSessionRoute(key: string, hostId: string, now: number): void {
  sessionRoutes.delete(key);
  sessionRoutes.set(key, { hostId, expiresAt: now + SESSION_ROUTE_TTL_MS });
  if (sessionRoutes.size > MAX_SESSION_ROUTES)
    sessionRoutes.delete(sessionRoutes.keys().next().value!);
}

const replayBody = Effect.fn("InferenceHttp.replayBody")(function* <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes = MAX_REPLAY_BODY_BYTES,
) {
  const pull = yield* Stream.toPull(stream);
  const prefix: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = yield* pull.pipe(Effect.result);
    if (Result.isFailure(next)) {
      if (!Cause.isDone(next.failure)) return yield* Effect.fail(next.failure);
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of prefix) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { body, stream: Stream.fromIterable(prefix) };
    }
    const batchSize = next.success.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (size + batchSize > maxBytes)
      return {
        body: undefined,
        stream: Stream.fromIterable([...prefix, ...next.success]).pipe(
          Stream.concat(Stream.fromPull(Effect.succeed(pull))),
        ),
      };
    prefix.push(...next.success);
    size += batchSize;
  }
});

function parseCatalog(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (!("data" in value) || !Array.isArray(value.data)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function requestMetadata(body: Uint8Array, encoding: string | undefined) {
  try {
    const decoded =
      encoding === "zstd"
        ? NodeZlib.zstdDecompressSync(body, { maxOutputLength: MAX_REPLAY_BODY_BYTES })
        : encoding === "gzip"
          ? NodeZlib.gunzipSync(body, { maxOutputLength: MAX_REPLAY_BODY_BYTES })
          : encoding === undefined || encoding === "identity"
            ? body
            : undefined;
    if (!decoded) return {};
    const value: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (value === null || typeof value !== "object") return {};
    return {
      model: "model" in value && typeof value.model === "string" ? value.model : undefined,
      promptCacheKey:
        "prompt_cache_key" in value && typeof value.prompt_cache_key === "string"
          ? value.prompt_cache_key
          : undefined,
    };
  } catch {
    return {};
  }
}

const grantDenied = () =>
  HttpServerResponse.jsonUnsafe(
    {
      type: "error",
      error: {
        type: "permission_error",
        message:
          "T3 inference access was denied. Check sharing and reconnect the route in Inference accounts.",
      },
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const targetPath = inferenceTarget(request.method, request.url);
  if (!targetPath) return HttpServerResponse.empty({ status: 404 });
  const key =
    request.headers.authorization?.match(/^Bearer ([^ ]+)$/i)?.[1] ?? request.headers["x-api-key"];
  if (!key) return HttpServerResponse.empty({ status: 401 });
  const host = yield* InferenceProxy;
  if (targetPath.path === "/health") {
    const health = yield* host.health(key, targetPath.environmentId, targetPath.driver);
    return health === null
      ? grantDenied()
      : HttpServerResponse.jsonUnsafe(health, { headers: { "cache-control": "no-store" } });
  }
  const canReplay = yield* host.hasRoutePool(key, targetPath.environmentId, targetPath.driver);
  const declaredLength = request.headers["content-length"];
  const length = Number(declaredLength);
  const buffered =
    request.method === "POST" &&
    canReplay &&
    (declaredLength === undefined ||
      (Number.isSafeInteger(length) && length <= MAX_REPLAY_BODY_BYTES))
      ? yield* replayBody(
          request.stream.pipe(Stream.mapError((cause) => new InferenceStreamError({ cause }))),
        )
      : { body: undefined, stream: request.stream };
  const { body } = buffered;
  const metadata = body ? requestMetadata(body, request.headers["content-encoding"]) : {};
  const model = metadata.model;
  const session =
    request.headers["x-session-id"] ??
    request.headers["session_id"] ??
    request.headers["session-id"] ??
    request.headers["x-claude-code-session-id"] ??
    request.headers["x-session-affinity"] ??
    metadata.promptCacheKey;
  const affinityKey = sessionRouteKey(key, targetPath.driver, model, session);
  const candidates = yield* host.routeCandidates(
    key,
    targetPath.environmentId,
    targetPath.driver,
    model,
    targetPath.path === "/v1/models",
  );
  if (candidates === null) return grantDenied();
  if (!candidates.length)
    return HttpServerResponse.jsonUnsafe(
      {
        type: "error",
        error: {
          type: "server_error",
          message: `No inference host is currently available${model ? ` for model ${model}` : ""}. Check Inference accounts or choose another model.`,
        },
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  const eligible = model
    ? candidates.filter((candidate) => candidate.models.includes(model))
    : candidates.slice(0, 1);
  let targets =
    targetPath.path === "/v1/models"
      ? candidates
      : eligible.length
        ? eligible
        : candidates.slice(0, 1);
  if (affinityKey) {
    const preferred = sessionRoutes.get(affinityKey);
    if (preferred && preferred.expiresAt <= (yield* Clock.currentTimeMillis))
      sessionRoutes.delete(affinityKey);
    else if (preferred) {
      const index = targets.findIndex((target) => target.hostId === preferred.hostId);
      if (index > 0)
        targets = [targets[index]!, ...targets.slice(0, index), ...targets.slice(index + 1)];
      else if (index < 0) sessionRoutes.delete(affinityKey);
    }
  }
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  let result;
  let catalogBase: Record<string, unknown> | undefined;
  const catalogModels = new Map<string, Record<string, unknown>>();
  let catalogBytes = 0;
  const catalogResponse = () =>
    HttpServerResponse.jsonUnsafe(
      { ...catalogBase, data: [...catalogModels.values()] },
      { headers: { "cache-control": "no-store, no-transform" } },
    );
  for (const [index, target] of targets.entries()) {
    const headers: Record<string, string> = { authorization: "Bearer " + target.key };
    for (const name of [
      "accept",
      "content-encoding",
      "anthropic-version",
      "anthropic-beta",
      "session_id",
      "session-id",
      "x-session-id",
      "x-session-affinity",
      "x-client-request-id",
      "x-codex-beta-features",
      "x-codex-turn-metadata",
      "x-codex-turn-state",
      "x-codex-window-id",
      "thread-id",
      "x-claude-code-session-id",
    ]) {
      const value = request.headers[name];
      if (value) headers[name] = value;
    }
    const outgoing = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
      target.baseUrl + targetPath.path,
    ).pipe(
      HttpClientRequest.setHeaders(headers),
      request.method === "POST"
        ? body
          ? HttpClientRequest.bodyUint8Array(body, "application/json")
          : HttpClientRequest.bodyStream(buffered.stream, { contentType: "application/json" })
        : (req) => req,
    );
    const attempt = yield* client
      .execute(outgoing)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.result,
      );
    if (Result.isFailure(attempt)) {
      if (affinityKey && target.hostId) sessionRoutes.delete(affinityKey);
      if (target.hostId && targetPath.driver && model)
        yield* host.recordRouteOutcome({
          driver: targetPath.driver,
          hostId: target.hostId,
          model,
          status: 502,
        });
      if (index < targets.length - 1) continue;
      if (catalogBase) return catalogResponse();
      return yield* attempt.failure;
    }
    result = attempt.success;
    if (affinityKey && target.hostId) {
      if (result.status < 400)
        rememberSessionRoute(affinityKey, target.hostId, yield* Clock.currentTimeMillis);
      else if (isRetryableInferenceStatus(result.status)) sessionRoutes.delete(affinityKey);
    }
    if (target.hostId && targetPath.driver && model)
      yield* host.recordRouteOutcome({
        driver: targetPath.driver,
        hostId: target.hostId,
        model,
        status: result.status,
        ...(result.headers["retry-after"] ? { retryAfter: result.headers["retry-after"] } : {}),
        ...(result.headers["retry-after-ms"]
          ? { retryAfterMs: result.headers["retry-after-ms"] }
          : {}),
      });
    if (targetPath.path === "/v1/models") {
      if (result.status >= 200 && result.status < 300) {
        const read = yield* replayBody(
          result.stream.pipe(Stream.mapError((cause) => new InferenceStreamError({ cause }))),
          MAX_CATALOG_BODY_BYTES,
        ).pipe(Effect.result);
        if (Result.isSuccess(read) && read.success.body) {
          const catalog = parseCatalog(read.success.body);
          if (catalog) {
            if (catalogBytes + read.success.body.byteLength > MAX_CATALOG_UNION_BYTES)
              return HttpServerResponse.empty({ status: 502 });
            catalogBytes += read.success.body.byteLength;
            catalogBase ??= catalog;
            for (const item of catalog.data as unknown[]) {
              if (!item || typeof item !== "object" || Array.isArray(item) || !("id" in item))
                continue;
              if (typeof item.id !== "string") continue;
              if (target.models.length && !target.models.includes(item.id)) continue;
              if (!catalogModels.has(item.id))
                catalogModels.set(item.id, item as Record<string, unknown>);
              if (catalogModels.size > MAX_CATALOG_MODELS)
                return HttpServerResponse.empty({ status: 502 });
            }
          }
        }
      }
      if (index < targets.length - 1) continue;
      if (catalogBase) return catalogResponse();
      if (result.status >= 200 && result.status < 300)
        return HttpServerResponse.empty({ status: 502 });
    }
    if (index < targets.length - 1 && isRetryableInferenceStatus(result.status)) continue;
    break;
  }
  if (!result) return HttpServerResponse.empty({ status: 502 });
  const responseOptions = {
    status: result.status,
    contentType: result.headers["content-type"] ?? "application/json",
    headers: {
      "cache-control": "no-store, no-transform",
      ...(result.headers["x-codex-turn-state"]
        ? { "x-codex-turn-state": result.headers["x-codex-turn-state"] }
        : {}),
      ...(result.headers["retry-after"] ? { "retry-after": result.headers["retry-after"] } : {}),
      ...(result.headers["retry-after-ms"]
        ? { "retry-after-ms": result.headers["retry-after-ms"] }
        : {}),
    },
  };
  if (
    targetPath.driver === "codex" &&
    result.status === 503 &&
    result.headers["content-type"]?.startsWith("application/json")
  ) {
    const delay = inferenceRetryDelayMs(
      result.headers["retry-after"],
      result.headers["retry-after-ms"],
      yield* Clock.currentTimeMillis,
    );
    if (delay !== undefined && delay > 0) {
      const buffered = yield* replayBody(result.stream, MAX_ERROR_BODY_BYTES);
      const decoded = buffered.body && decodeErrorJson(new TextDecoder().decode(buffered.body));
      if (decoded && Option.isSome(decoded) && isProviderError(decoded.value)) {
        const payload = decoded.value;
        const seconds = Math.ceil(delay / 1000);
        // Codex displays the error message but omits Retry-After from retry notifications.
        return HttpServerResponse.jsonUnsafe(
          {
            ...payload,
            error: {
              ...payload.error,
              message: `${payload.error.message} Retry after ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
            },
          },
          responseOptions,
        );
      }
      return HttpServerResponse.stream(buffered.stream, responseOptions);
    }
  }
  return HttpServerResponse.stream(result.stream, responseOptions);
}).pipe(
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 })),
  Effect.withTracerEnabled(false),
);
export const layer = Layer.unwrap(
  Effect.map(InferenceProxy, (host) =>
    HttpRouter.add(
      "*",
      "/api/inference/*",
      handler.pipe(Effect.provideService(InferenceProxy, host)),
    ),
  ),
);
