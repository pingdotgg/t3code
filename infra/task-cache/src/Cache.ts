import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Cloudflare from "@cloudflare/workers-types";
import { Summary, recordSummary } from "./Summary.ts";
import * as Savings from "./Savings.ts";
import type { ProtocolBindings } from "./protocolTypes.ts";
import * as Admission from "./Admission.ts";
import { developerIdentity } from "./developerAuth.ts";

const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(Summary));

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  status: Schema.Number,
  reason: Schema.String,
}) {}

export class Bindings extends Context.Service<
  Bindings,
  ProtocolBindings & {
    readonly developerKeys: string;
    readonly readerKeys: string;
    readonly readLimit: Cloudflare.RateLimit;
    readonly storeLimit: Cloudflare.RateLimit;
  }
>()("@t3tools/task-cache/Cache/Bindings") {}

export class Cache extends Context.Service<
  Cache,
  {
    readonly handle: (
      request: Request,
      context: Pick<Cloudflare.ExecutionContext, "waitUntil">,
    ) => Effect.Effect<Response>;
    readonly cleanup: Effect.Effect<void, CacheError>;
  }
>()("@t3tools/task-cache/Cache") {}

const make = Effect.gen(function* () {
  const bindings = yield* Bindings;
  const admission = yield* Admission.Admission;
  const savings = yield* Savings.Savings;
  // The source-only protocol dependency is bundled for Workers, never evaluated by Node during deployment.
  const {
    authorizeCacheWrite,
    authorizeTelemetry,
    keys,
    cborResponse,
    cleanup,
    getScope,
    selectBlob,
    errorResponse,
    HttpError,
    fetchMetadata,
    defaults,
    store,
    readBody,
    Deadline,
    Observations,
  } = yield* Effect.promise(() => import("./protocol.ts"));

  // The upstream adapter owns the experimental wire format and atomic D1 publication.
  const protocol = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new CacheError({
          status: cause instanceof HttpError ? cause.status : 503,
          reason: cause instanceof HttpError ? cause.code : "unavailable",
        }),
    });

  const checkLimit = Effect.fn("TaskCache.checkLimit")(function* (operation: string) {
    const allowed = yield* protocol(() =>
      (operation === "store" ? bindings.storeLimit : bindings.readLimit).limit({
        key: `t3code:${operation.startsWith("blob/") ? "blob" : operation}`,
      }),
    );
    if (!allowed.success) return yield* new CacheError({ status: 429, reason: "rate_limit" });
  });

  const handle = Effect.fn("TaskCache.handle")(
    function* (request: Request, context: Pick<Cloudflare.ExecutionContext, "waitUntil">) {
      const url = new URL(request.url);
      const route = /^\/projects\/t3code\/(fetch|store|telemetry|blob\/([0-9a-f-]{36}))$/.exec(
        url.pathname,
      );
      const operation = route?.[1] ?? "unknown";
      const writing = operation === "store";
      yield* Effect.annotateCurrentSpan({
        "cache.operation": operation.startsWith("blob/") ? "blob" : operation,
      });
      if (
        !route ||
        url.search ||
        request.method !== (operation.startsWith("blob/") ? "GET" : "POST")
      ) {
        return yield* new CacheError({ status: 404, reason: "unknown_route" });
      }
      if (!request.headers.has("authorization"))
        return yield* new CacheError({ status: 401, reason: "missing_identity" });
      const developer = yield* developerIdentity(request, bindings.developerKeys);
      if (writing || operation === "telemetry") {
        if (developer === null)
          return yield* new CacheError({ status: 403, reason: "invalid_identity" });
      } else {
        const reader = developer ?? (yield* developerIdentity(request, bindings.readerKeys));
        if (typeof reader !== "string")
          return yield* new CacheError({ status: 403, reason: "read_denied" });
      }
      return yield* admission
        .withPermit(
          writing,
          Effect.scoped(
            Effect.gen(function* () {
              const controller = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (value) => Effect.sync(() => value.abort()),
              );
              const deadline = yield* Effect.acquireRelease(
                Effect.sync(
                  () =>
                    new Deadline(
                      writing ? defaults.deadlineMs : 15000,
                      AbortSignal.any([request.signal, controller.signal]),
                    ),
                ),
                (value) =>
                  Effect.sync(() => {
                    controller.abort();
                    value.dispose();
                  }),
              );
              const stats = new Observations();
              yield* Effect.addFinalizer(() =>
                Effect.annotateCurrentSpan(
                  Object.fromEntries(
                    Object.entries(stats.toJSON()).map(([key, value]) => [`cache.${key}`, value]),
                  ),
                ),
              );
              if (!writing && operation !== "telemetry") yield* checkLimit(operation);
              const scope = yield* protocol(() => getScope(bindings.INDEX, "t3code", stats));
              if (operation === "telemetry") {
                let identity = developer ?? undefined;
                if (identity === undefined) {
                  identity = yield* protocol(() => authorizeTelemetry(request, scope, keys));
                }
                yield* checkLimit(operation);
                const bytes = yield* protocol(() => readBody(request.body, 256 * 1024, deadline));
                const summary = yield* decodeSummary(new TextDecoder().decode(bytes)).pipe(
                  Effect.mapError(() => new CacheError({ status: 400, reason: "invalid_summary" })),
                );
                if (summary.tasks.length === 0) return new Response(null, { status: 204 });
                const now = yield* Clock.currentTimeMillis;
                if (summary.recordedAt > now + 60_000 || summary.recordedAt < now - 30 * 86400_000)
                  return yield* new CacheError({ status: 400, reason: "summary_expired" });
                yield* savings
                  .record(summary, identity)
                  .pipe(
                    Effect.mapError(
                      () => new CacheError({ status: 503, reason: "telemetry_unavailable" }),
                    ),
                  );
                yield* recordSummary(summary, identity);
                yield* savings
                  .emitTotals(identity, summary.host)
                  .pipe(
                    Effect.mapError(
                      () => new CacheError({ status: 503, reason: "telemetry_unavailable" }),
                    ),
                  );
                return new Response(null, { status: 204 });
              }
              if (writing) {
                if (developer !== undefined && !scope.writes_enabled) {
                  return yield* new CacheError({ status: 403, reason: "developer_write_denied" });
                }
                const now = yield* Clock.currentTimeMillis;
                const identity =
                  developer === undefined
                    ? yield* protocol(() => authorizeCacheWrite(request, scope, keys))
                    : {
                        exp: Math.floor(now / 1000) + 900,
                        repository_id: scope.repository_id,
                        workflow_ref: `developer/${developer}`,
                      };
                yield* checkLimit(operation);
                return yield* protocol(() =>
                  store(request, bindings, context, scope, identity, defaults, deadline, stats),
                );
              }
              if (operation === "fetch") {
                const result = yield* protocol(() =>
                  fetchMetadata(request, bindings, "t3code", defaults, deadline, stats),
                );
                return cborResponse(result);
              }
              const selected = yield* protocol(() =>
                selectBlob(bindings.INDEX, "t3code", route[2]!, stats),
              );
              if (!selected) return yield* new CacheError({ status: 404, reason: "blob_missing" });
              stats.r2_operations++;
              const object = yield* protocol(() => bindings.ARTIFACTS.get(selected.blob_object));
              if (!object) return yield* new CacheError({ status: 404, reason: "blob_missing" });
              if (object.size !== selected.blob_size)
                return yield* new CacheError({ status: 503, reason: "blob_size" });
              return new Response(object.body, {
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(object.size),
                  "Cache-Control": "no-store",
                },
              });
            }),
          ),
        )
        .pipe(
          Effect.timeout(writing ? "2 minutes" : "15 seconds"),
          Effect.catchTags({
            AdmissionRejected: () =>
              Effect.fail(new CacheError({ status: 503, reason: "concurrency_limit" })),
            TimeoutError: () => Effect.fail(new CacheError({ status: 503, reason: "deadline" })),
          }),
        );
    },
    Effect.catchTags({
      // The enclosing operation owns the span for this inline handler.
      CacheError: Effect.fnUntraced(function* (error) {
        if (error.status >= 500)
          yield* Effect.logWarning("Cache request failed", { reason: error.reason });
        return errorResponse(new HttpError(error.status, error.reason));
      }),
    }),
  );

  return Cache.of({ handle, cleanup: protocol(() => cleanup(bindings)) });
});

export const layer = Layer.effect(Cache, make);
