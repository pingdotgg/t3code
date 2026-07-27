/**
 * Shared batch exporter for OTLP/HTTP observability modules.
 *
 * Signal modules use this exporter to buffer already-encoded telemetry and post
 * it to a configured OTLP endpoint. It owns the scoped transport loop, batching,
 * retry behavior, temporary disabling after repeated failures, and final flush
 * during shutdown.
 *
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Fiber from "../../Fiber.ts"
import * as FiberSet from "../../FiberSet.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Num from "../../Number.ts"
import * as Option from "../../Option.ts"
import * as Schedule from "../../Schedule.ts"
import * as Scope from "../../Scope.ts"
import * as Headers from "../../unstable/http/Headers.ts"
import * as HttpClient from "../../unstable/http/HttpClient.ts"
import * as HttpClientError from "../../unstable/http/HttpClientError.ts"
import * as HttpClientRequest from "../../unstable/http/HttpClientRequest.ts"
import type { HttpBody } from "../http/HttpBody.ts"

const policy = Schedule.forever.pipe(
  Schedule.passthrough,
  Schedule.addDelay(({ output: error }) => {
    if (
      HttpClientError.isHttpClientError(error)
      && error.reason._tag === "StatusCodeError"
      && error.reason.response.status === 429
    ) {
      const retryAfter = Option.fromUndefinedOr(error.reason.response.headers["retry-after"]).pipe(
        Option.flatMap(Num.parse),
        Option.getOrElse(() => 5)
      )
      return Effect.succeed(Duration.seconds(retryAfter))
    }
    return Effect.succeed(Duration.seconds(1))
  })
)

/**
 * Registry of exporter flush operations, used to manually drain buffered
 * telemetry before the surrounding scope closes.
 *
 * **Details**
 *
 * Every exporter created by `make` registers its export operation here, so a
 * single `flush` drains all signals sharing the registry. `flush` returns only
 * after the exports it initiated have settled, cannot fail, and respects each
 * exporter's temporary-disable window. Wrap it with `Effect.timeoutOption` to
 * bound its duration at the call site.
 *
 * @category flushing
 * @since 4.0.0
 */
export class Flusher extends Context.Service<Flusher, {
  /**
   * Drains all registered exporters concurrently and cannot fail.
   *
   * **Details**
   *
   * There is no built-in timeout; use `Effect.timeoutOption` to bound the
   * operation. Exporters in their 60-second `disabledUntil` window are skipped.
   *
   * **Example** (Flushing from a Cloudflare Worker)
   *
   * ```ts
   * import { Effect, ManagedRuntime } from "effect"
   * import { OtlpExporter, OtlpTracer } from "effect/unstable/observability"
   *
   * const layer = OtlpTracer.layerFromConfig()
   * const runtime = ManagedRuntime.make(layer)
   *
   * // In the request handler:
   * ctx.waitUntil(
   *   runtime.runPromise(
   *     Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush)
   *   )
   * )
   * ```
   */
  readonly flush: Effect.Effect<void>
  readonly register: (run: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
}>()(
  "effect/observability/OtlpExporter/Flusher"
) {}

/**
 * Provides a `Flusher` backed by a fresh registry.
 *
 * **Details**
 *
 * This is intentionally a single module-level constant rather than a factory:
 * layer memoization is keyed by layer instance, so every signal layer
 * referencing this same constant shares one registry per layer build, and one
 * `flush` drains traces, logs and metrics together. A factory returning a new
 * layer per call would silently create one registry per signal.
 *
 * Registration is scoped — an exporter is removed from the registry when its
 * own scope closes. Flushing with an empty registry is a no-op.
 *
 * Note that `flush` cannot await an export that was already in flight when it
 * was called (for example one started by the export interval); it only waits
 * for the exports it initiates.
 *
 * @category flushing
 * @since 4.0.0
 */
export const layerFlusher: Layer.Layer<Flusher> = Layer.sync(Flusher, () => {
  const registry = new Set<Effect.Effect<void>>()
  return {
    flush: Effect.suspend(() => {
      if (registry.size === 0) {
        return Effect.void
      }
      return Effect.forEach(registry, identity, {
        concurrency: "unbounded",
        discard: true
      })
    }),
    register: (run) =>
      Effect.flatMap(Scope.Scope, (scope) => {
        registry.add(run)
        return Scope.addFinalizer(
          scope,
          Effect.sync(() => registry.delete(run))
        )
      })
  }
})

/**
 * Creates a scoped OTLP batch exporter.
 *
 * **Details**
 *
 * The exporter buffers pushed data, periodically posts encoded batches to the
 * configured URL, retries transient failures, temporarily disables exporting
 * after unhandled failures, and flushes during scope finalization up to
 * `shutdownTimeout`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (
  options: {
    readonly url: string
    readonly headers: Headers.Input | undefined
    readonly label: string
    readonly exportInterval: Duration.Input
    readonly maxBatchSize: number | "disabled"
    readonly body: (data: Array<any>) => HttpBody
    readonly shutdownTimeout: Duration.Input
  }
) => Effect.Effect<
  { readonly push: (data: unknown) => void },
  never,
  Flusher | HttpClient.HttpClient | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const services = yield* Effect.context<Scope.Scope | HttpClient.HttpClient>()
  const clock = Context.get(services, Clock)
  const scope = Context.get(services, Scope.Scope)
  const exportInterval = Duration.max(Duration.fromInputUnsafe(options.exportInterval), Duration.zero)
  let disabledUntil: number | undefined = undefined

  const client = HttpClient.filterStatusOk(Context.get(services, HttpClient.HttpClient)).pipe(
    HttpClient.transformResponse(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
    HttpClient.retryTransient({ schedule: policy, times: 3 })
  )

  let headers = Headers.fromRecordUnsafe({
    "user-agent": `effect-opentelemetry-${options.label}/0.0.0`
  })
  if (options.headers) {
    headers = Headers.merge(Headers.fromInput(options.headers), headers)
  }

  const request = HttpClientRequest.post(options.url, { headers })
  let buffer: Array<any> = []
  const runExport = Effect.suspend(() => {
    if (disabledUntil !== undefined && clock.currentTimeMillisUnsafe() < disabledUntil) {
      return Effect.void
    } else if (disabledUntil !== undefined) {
      disabledUntil = undefined
    }
    const items = buffer
    if (options.maxBatchSize !== "disabled") {
      if (buffer.length === 0) {
        return Effect.void
      }
      buffer = []
    }
    return client.execute(
      HttpClientRequest.setBody(request, options.body(items))
    ).pipe(
      Effect.asVoid,
      Effect.withTracerEnabled(false)
    )
  }).pipe(
    Effect.catchCause((cause) => {
      if (disabledUntil !== undefined) return Effect.void
      disabledUntil = clock.currentTimeMillisUnsafe() + 60_000
      buffer = []
      return Effect.logDebug("Disabling exporter for 60 seconds", cause)
    }),
    Effect.annotateLogs({
      package: "@effect/opentelemetry",
      module: options.label
    })
  )

  const exportFibers = yield* FiberSet.make<void, never>()
  const runExportFork = yield* FiberSet.runtime(exportFibers)<never>()

  const flusher = yield* Flusher
  yield* flusher.register(runExport)

  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => {
      if (disabledUntil !== undefined) return Effect.void
      runExportFork(runExport)
      return FiberSet.awaitEmpty(exportFibers)
    }).pipe(
      Effect.ignore,
      Effect.interruptible,
      Effect.timeoutOption(options.shutdownTimeout)
    )
  )

  yield* Effect.sleep(exportInterval).pipe(
    Effect.andThen(FiberSet.run(exportFibers, runExport)),
    Effect.flatMap(Fiber.await),
    Effect.forever,
    Effect.forkIn(scope)
  )

  return {
    push(data) {
      if (disabledUntil !== undefined) return
      buffer.push(data)
      if (options.maxBatchSize !== "disabled" && buffer.length >= options.maxBatchSize) {
        runExportFork(runExport)
      }
    }
  }
})
