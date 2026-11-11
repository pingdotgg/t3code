/**
 * Shared batch exporter for OTLP/HTTP observability modules.
 *
 * Signal modules use this exporter to buffer already-encoded telemetry and post
 * it to a configured OTLP endpoint. It owns the scoped transport loop, batching,
 * retry behavior, temporary disabling after repeated failures, and final flush
 * during shutdown.
 *
 * @stability unstable
 * @since 4.0.0
 */
import { Clock } from "../Clock.ts"
import * as Context from "../Context.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import * as Fiber from "../Fiber.ts"
import * as FiberSet from "../FiberSet.ts"
import { identity } from "../Function.ts"
import * as Headers from "../http/Headers.ts"
import type { HttpBody } from "../http/HttpBody.ts"
import * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientError from "../http/HttpClientError.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as Latch from "../Latch.ts"
import * as Layer from "../Layer.ts"
import * as Result from "../Result.ts"
import * as Schedule from "../Schedule.ts"
import * as Scope from "../Scope.ts"
import * as Version from "../Version.ts"

// A missing or invalid Retry-After falls back to a fixed delay.
const retryAfterDelay = (value: string | undefined): Effect.Effect<Duration.Duration> => {
  const retryAfter = value === undefined ? undefined : Headers.parseRetryAfter(value)
  if (retryAfter === undefined || Result.isFailure(retryAfter)) {
    return Effect.succeed(Duration.seconds(5))
  }
  return Effect.map(
    Clock,
    (clock) => Headers.retryAfterDelay(retryAfter.success, clock.currentTimeMillisUnsafe())
  )
}

const policy = Schedule.forever.pipe(
  Schedule.passthrough,
  Schedule.addDelay(({ output: error }) => {
    if (
      HttpClientError.isHttpClientError(error)
      && error.reason._tag === "StatusCodeError"
      && error.reason.response.status === 429
    ) {
      return retryAfterDelay(error.reason.response.headers["retry-after"])
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
 * @stability unstable
 * @category services
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
   * **Example** (Flushing exporters)
   *
   * ```ts import.meta.vitest
   * import { Effect } from "effect"
   * import { OtlpExporter } from "effect/observability"
   *
   * const program = Effect.gen(function*() {
   *   const flusher = yield* OtlpExporter.Flusher
   *   yield* flusher.flush
   *   return "flushed"
   * }).pipe(Effect.provide(OtlpExporter.layerFlusher))
   *
   * await Effect.runPromise(program) // => "flushed"
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
 * @stability unstable
 * @category layers
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
 * The export interval starts with the first push and stops once an export
 * empties the buffer, so an idle exporter keeps no timer pending. With
 * `exportEmpty` and batching disabled, it exports on every interval instead.
 *
 * Optional gzip compression uses `HttpClientRequest.compressBody` before the
 * retry loop, so retries reuse the compressed bytes. Bodies smaller than 1KB
 * remain uncompressed. Compression requires runtime `CompressionStream` support;
 * compression failures follow the same temporary-disable behavior as transport
 * failures and do not fail flushing or shutdown.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make: (
  options: {
    readonly url: string
    readonly headers: Headers.Input | undefined
    /** Gzip uses the default 1KB minimum body size; smaller batches remain uncompressed. */
    readonly compression?: "gzip" | "none" | undefined
    readonly label: string
    readonly exportInterval: Duration.Input
    readonly maxBatchSize: number | "disabled"
    readonly exportEmpty?: boolean | undefined
    readonly body: (data: Array<any>) => readonly [body: HttpBody, onSuccess: Effect.Effect<void>]
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

  const client = Context.get(services, HttpClient.HttpClient).pipe(
    HttpClient.tap((response) => Effect.ignore(response.arrayBuffer)),
    HttpClient.tapError((error) => error.response ? Effect.ignore(error.response.arrayBuffer) : Effect.void),
    HttpClient.filterStatusOk,
    HttpClient.transformResponse(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
    HttpClient.retryTransient({ schedule: policy, times: 3 })
  )

  const exporterUserAgent = `OTel-OTLP-Exporter-JavaScript-Effect-${options.label}/${Version.getCurrentVersion()}`
  const userHeaders = Headers.fromInput(options.headers)
  const userAgent = userHeaders["user-agent"]
  const headers = Headers.set(
    userHeaders,
    "user-agent",
    userAgent ? `${userAgent} ${exporterUserAgent}` : exporterUserAgent
  )

  const request = HttpClientRequest.post(options.url, { headers })
  const exportsEmpty = options.maxBatchSize === "disabled" && options.exportEmpty === true
  let buffer: Array<any> = []
  let disabledUntil: number | undefined = undefined
  const isDisabled = () => {
    if (disabledUntil === undefined) return false
    if (clock.currentTimeMillisUnsafe() < disabledUntil) return true
    disabledUntil = undefined
    return false
  }

  const runExport = Effect.suspend(() => {
    if (isDisabled() || (buffer.length === 0 && !exportsEmpty)) {
      return Effect.void
    }
    const items = buffer
    buffer = []
    const [body, onSuccess] = options.body(items)
    const batchRequest = HttpClientRequest.setBody(request, body)
    // Compress before client.execute so transient retries reuse the encoded bytes.
    const response = options.compression === "gzip"
      ? HttpClientRequest.compressBody(batchRequest, "gzip").pipe(Effect.flatMap(client.execute))
      : client.execute(batchRequest)
    return response.pipe(
      Effect.andThen(onSuccess),
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

  // `armed` is open while there is something to export. It changes in the
  // same synchronous step as the buffer check, so a push is never stranded.
  const armed = yield* Latch.make(exportsEmpty)
  const wake = yield* Latch.make()
  const disarmIfEmpty = Effect.sync(() => {
    if (exportsEmpty || buffer.length > 0 || !armed.closeUnsafe()) return
    wake.openUnsafe()
  })
  // Forked after the shutdown finalizer, so the loop stops before the shutdown flush.
  yield* Effect.gen(function*() {
    while (true) {
      wake.closeUnsafe()
      yield* armed.await
      yield* Effect.race(Effect.sleep(exportInterval), wake.await)
      yield* Fiber.await(yield* FiberSet.run(exportFibers, runExport))
      yield* disarmIfEmpty
    }
  }).pipe(Effect.forkIn(scope))
  const exportNow = Effect.andThen(runExport, disarmIfEmpty)

  const flusher = yield* Flusher
  yield* flusher.register(exportNow)

  return {
    push(data) {
      // With no idle timer, the next push ends the disabled window.
      if (isDisabled()) return
      buffer.push(data)
      if (options.maxBatchSize !== "disabled" && buffer.length >= options.maxBatchSize) {
        runExportFork(exportNow)
      } else {
        armed.openUnsafe()
      }
    }
  }
})
