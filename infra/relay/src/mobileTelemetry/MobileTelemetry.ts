/**
 * Receives the OTLP/JSON that `expo-observe` sends from the mobile app and
 * forwards it to Axiom. The app points Observe's `endpointUrl` here because
 * Observe cannot add auth headers and prefixes every path with the EAS
 * project id. On the way through, JavaScript exception stacks are
 * symbolicated with the bundle's source map from R2.
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi } from "@t3tools/contracts/relay";

import { applySymbolication, bundleSourceMapKey, collectJsExceptions } from "./otlpLogs.ts";
import { decodeSourceMap, type CompactSourceMap } from "./sourceMap.ts";

/** Observe splits batches the endpoint answers 413 for, so this only bounds one request. */
export const MOBILE_TELEMETRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Per client IP. An app flushes a few batches per launch and background. */
export const MOBILE_TELEMETRY_RATE_LIMIT = { limit: 120, periodSeconds: 60 } as const;
/**
 * Inside the relay's 9 s request deadline (`RELAY_REQUEST_DEADLINE_MS`), with
 * room left for reading the body and symbolicating, so a slow Axiom answers as
 * `upstream_timeout` rather than the generic deadline error.
 */
const UPSTREAM_TIMEOUT = Duration.seconds(7);
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
/**
 * A decoded production Hermes map is about 20 MB and `decodeSourceMap` refuses
 * one over 32 MB, so a Worker isolate keeps two: enough for the current iOS
 * and Android bundles.
 */
const SOURCE_MAP_CACHE_CAPACITY = 2;
/**
 * About twice a stripped production map today. A larger object, such as one
 * written with a leaked upload token, is skipped unread rather than decoded
 * past the isolate's memory.
 */
export const MAX_SOURCE_MAP_BYTES = 16 * 1024 * 1024;
/**
 * How much symbolication may lengthen one request. A request can carry
 * thousands of frames, each rewritten to a longer source path.
 */
const MAX_SYMBOLICATION_GROWTH = 1024 * 1024;
/**
 * One app sends a request, so it names one bundle, or two across an OTA
 * update. Each further id would be an R2 read that evicts a cached map.
 */
const MAX_SOURCE_MAPS_PER_REQUEST = 2;
/** A map can land in R2 a moment after its update ships, so a miss is retried. */
const MISSING_SOURCE_MAP_TTL = Duration.minutes(5);
const FAILED_SOURCE_MAP_TTL = Duration.seconds(30);

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(UnknownFromJsonString);
const encodeJson = Schema.encodeSync(UnknownFromJsonString);
const parseJson = (text: string): unknown => Option.getOrUndefined(decodeJson(text));

/** `<endpointUrl>/<easProjectId>/v1/<signal>`, as Observe builds it. */
const INGEST_PATH = /^\/v1\/mobile\/observe\/([0-9A-Fa-f-]{36})\/v1\/(logs|metrics|traces)$/u;

export type OtlpSignal = "logs" | "metrics" | "traces";

export interface AxiomDestination {
  /** Axiom's OTLP/HTTP endpoint for the signal, such as `.../v1/logs`. */
  readonly url: string;
  readonly dataset: string;
}

export class MobileTelemetrySettings extends Context.Service<
  MobileTelemetrySettings,
  {
    /** Ingest-only token for the three datasets. */
    readonly axiomToken: Redacted.Redacted<string>;
    readonly destinations: Readonly<Record<OtlpSignal, AxiomDestination>>;
  }
>()("t3code-relay/mobileTelemetry/MobileTelemetry/MobileTelemetrySettings") {}

export class MobileTelemetryRateLimiter extends Context.Service<
  MobileTelemetryRateLimiter,
  { readonly allow: (key: string) => Effect.Effect<boolean> }
>()("t3code-relay/mobileTelemetry/MobileTelemetry/MobileTelemetryRateLimiter") {}

export class SourceMapObjectError extends Schema.TaggedError<SourceMapObjectError>()(
  "SourceMapObjectError",
  { key: Schema.String, cause: Schema.Defect() },
) {}

/** An object in the source maps bucket, read only once its size is known to fit. */
export interface StoredSourceMap {
  readonly size: number;
  readonly text: Effect.Effect<string, SourceMapObjectError>;
}

export interface FoundSourceMap {
  readonly key: string;
  readonly map: CompactSourceMap;
}

/** Decoded source maps, by the key `bundleSourceMapKey` gives for a bundle. */
export class SourceMaps extends Context.Service<
  SourceMaps,
  {
    /** Undefined when no map is stored under `key` or it cannot be read. */
    readonly find: (key: string) => Effect.Effect<FoundSourceMap | undefined>;
  }
>()("t3code-relay/mobileTelemetry/MobileTelemetry/SourceMaps") {}

/** The source maps bucket. */
export class SourceMapObjects extends Context.Service<
  SourceMapObjects,
  {
    /** Undefined when nothing is stored under `key`. */
    readonly get: (key: string) => Effect.Effect<StoredSourceMap | undefined, SourceMapObjectError>;
  }
>()("t3code-relay/mobileTelemetry/MobileTelemetry/SourceMapObjects") {}

const makeSourceMaps = Effect.gen(function* () {
  const objects = yield* SourceMapObjects;
  const cache = yield* Cache.makeWith(
    (key: string) =>
      Effect.gen(function* () {
        const stored = yield* objects.get(key);
        if (stored === undefined) return undefined;
        if (stored.size > MAX_SOURCE_MAP_BYTES) {
          yield* Effect.logWarning("Stored mobile source map is too large", {
            key,
            size: stored.size,
          });
          return undefined;
        }
        const map = decodeSourceMap(parseJson(yield* stored.text));
        if (map) return { key, map } satisfies FoundSourceMap;
        yield* Effect.logWarning("Stored mobile source map could not be decoded", { key });
        return undefined;
      }),
    {
      capacity: SOURCE_MAP_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isFailure(exit)
          ? FAILED_SOURCE_MAP_TTL
          : exit.value
            ? Duration.infinity
            : MISSING_SOURCE_MAP_TTL,
    },
  );
  return SourceMaps.of({
    find: (key) =>
      Cache.get(cache, key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Mobile source map lookup failed", { key: error.key }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
  });
});

/**
 * Source map lookups over stored map text, cached. Build it once per Worker
 * isolate, not per request: decoding a production map costs ~150 ms.
 */
export const layerSourceMaps = Layer.effect(SourceMaps, makeSourceMaps);

export class MobileTelemetry extends Context.Service<
  MobileTelemetry,
  {
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("t3code-relay/mobileTelemetry/MobileTelemetry") {}

class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {}) {}

const errorResponse = (status: number, error: string, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, ...(headers ? { headers } : {}) });

const readCapped = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.length;
        if (total > maxBytes) return Effect.fail(new BodyTooLarge());
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

const hasNoBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof Request && request.source.body === null;

const make = Effect.gen(function* () {
  const settings = yield* MobileTelemetrySettings;
  const rateLimiter = yield* MobileTelemetryRateLimiter;
  const sourceMaps = yield* SourceMaps;
  const httpClient = yield* HttpClient.HttpClient;

  /** Symbolicates JS exceptions in a logs request; undefined when nothing changed. */
  const symbolicateLogs = Effect.fn("relay.mobile_telemetry.symbolicate")(function* (
    body: Uint8Array,
  ) {
    const payload = parseJson(new TextDecoder().decode(body));
    const exceptions = collectJsExceptions(payload);
    if (exceptions.length === 0) return undefined;
    let symbolicated = 0;
    let growthLeft = MAX_SYMBOLICATION_GROWTH;
    const keys = new Set<string>();
    for (const exception of exceptions) {
      const key = bundleSourceMapKey(exception.identity);
      if (key !== undefined && keys.size < MAX_SOURCE_MAPS_PER_REQUEST) keys.add(key);
      const outcome = applySymbolication(
        exception,
        key === undefined || !keys.has(key) ? undefined : yield* sourceMaps.find(key),
        growthLeft,
      );
      growthLeft -= outcome.growth;
      if (outcome.status === "symbolicated") symbolicated += 1;
    }
    yield* Effect.annotateCurrentSpan({
      "relay.mobile_telemetry.exceptions": exceptions.length,
      "relay.mobile_telemetry.symbolicated": symbolicated,
    });
    return new TextEncoder().encode(encodeJson(payload));
  });

  const forward = Effect.fn("relay.mobile_telemetry.forward")(function* (
    destination: AxiomDestination,
    body: Uint8Array,
  ) {
    const response = yield* httpClient.execute(
      HttpClientRequest.post(destination.url, {
        headers: {
          authorization: `Bearer ${Redacted.value(settings.axiomToken)}`,
          "x-axiom-dataset": destination.dataset,
        },
      }).pipe(HttpClientRequest.bodyUint8Array(body, "application/json")),
    );
    const responseBody = yield* readCapped(response.stream, MAX_UPSTREAM_RESPONSE_BYTES).pipe(
      // A response without a body has no stream at all.
      Effect.catchIf(
        (error) => error._tag === "HttpClientError" && error.reason._tag === "EmptyBodyError",
        () => Effect.succeed(new Uint8Array(0)),
      ),
    );
    return { response, body: responseBody };
  }, Effect.timeoutOption(UPSTREAM_TIMEOUT));

  const handle = Effect.fn("relay.mobile_telemetry.ingest")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const outcome = (value: string) =>
      Effect.annotateCurrentSpan({ "relay.mobile_telemetry.outcome": value });
    const match = INGEST_PATH.exec(new URL(request.url, "http://relay").pathname);
    if (!match) {
      yield* outcome("invalid_path");
      return errorResponse(404, "not_found");
    }
    const signal = match[2] as OtlpSignal;
    yield* Effect.annotateCurrentSpan({
      "relay.mobile_telemetry.project_id": match[1],
      "relay.mobile_telemetry.signal": signal,
    });

    const clientIp = request.headers["cf-connecting-ip"] ?? "unknown";
    if (!(yield* rateLimiter.allow(clientIp))) {
      yield* outcome("rate_limited");
      return errorResponse(429, "rate_limited", {
        "retry-after": String(MOBILE_TELEMETRY_RATE_LIMIT.periodSeconds),
      });
    }

    const read = yield* (
      hasNoBody(request)
        ? Effect.succeed(new Uint8Array(0))
        : readCapped(request.stream, MOBILE_TELEMETRY_MAX_BODY_BYTES)
    ).pipe(Effect.result);
    if (Result.isFailure(read)) {
      const tooLarge = read.failure._tag === "BodyTooLarge";
      yield* outcome(tooLarge ? "body_too_large" : "body_unreadable");
      return errorResponse(tooLarge ? 413 : 400, tooLarge ? "body_too_large" : "invalid_body");
    }
    yield* Effect.annotateCurrentSpan({ "relay.mobile_telemetry.bytes": read.success.length });

    // Forwarding matters more than symbolication: on any defect there, the
    // original payload goes through untouched.
    const body =
      signal === "logs"
        ? ((yield* symbolicateLogs(read.success).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Mobile stack symbolication failed", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          )) ?? read.success)
        : read.success;

    const upstream = yield* forward(settings.destinations[signal], body).pipe(Effect.result);
    if (Result.isFailure(upstream)) {
      yield* outcome("upstream_unavailable");
      return errorResponse(502, "upstream_unavailable");
    }
    if (Option.isNone(upstream.success)) {
      yield* outcome("upstream_timeout");
      return errorResponse(504, "upstream_timeout");
    }
    const { response, body: responseBody } = upstream.success.value;
    yield* outcome("forwarded");
    yield* Effect.annotateCurrentSpan({
      "relay.mobile_telemetry.upstream_status": response.status,
    });
    // Status, content type and Retry-After drive Observe's retry and
    // partial-success handling; nothing else from Axiom is passed on.
    const contentType = response.headers["content-type"];
    const retryAfter = response.headers["retry-after"];
    const headers = retryAfter === undefined ? undefined : { "retry-after": retryAfter };
    if (responseBody.length === 0) {
      return HttpServerResponse.empty({ status: response.status, ...(headers ? { headers } : {}) });
    }
    return HttpServerResponse.uint8Array(responseBody, {
      status: response.status,
      ...(headers ? { headers } : {}),
      ...(contentType ? { contentType } : {}),
    });
  });

  return MobileTelemetry.of({ handle });
});

export const layer = Layer.effect(MobileTelemetry, make);

/** Implements the RelayApi `mobileTelemetry` group; raw so the body is read once, capped. */
export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "mobileTelemetry",
  Effect.fnUntraced(function* (handlers) {
    const telemetry = yield* MobileTelemetry;
    return handlers.handleRaw("ingest", ({ request }) => telemetry.handle(request));
  }),
);
