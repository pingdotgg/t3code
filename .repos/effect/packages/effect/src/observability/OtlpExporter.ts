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
import type * as Fiber from "../Fiber.ts"
import { identity } from "../Function.ts"
import * as Headers from "../http/Headers.ts"
import type { HttpBody } from "../http/HttpBody.ts"
import * as HttpClient from "../http/HttpClient.ts"
import * as HttpClientError from "../http/HttpClientError.ts"
import * as HttpClientRequest from "../http/HttpClientRequest.ts"
import * as Count from "../internal/count.ts"
import * as Latch from "../Latch.ts"
import * as Layer from "../Layer.ts"
import * as MutableList from "../MutableList.ts"
import * as Result from "../Result.ts"
import * as Schedule from "../Schedule.ts"
import * as Scope from "../Scope.ts"
import type { Concurrency } from "../Types.ts"
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
 * Every exporter created by `make` registers its flush operation here, so a
 * single `flush` drains all signals sharing the registry concurrently while
 * each exporter respects its own `concurrency` limit. For each exporter,
 * `flush` returns once every export already in flight when it was called has
 * settled and every item accepted before the call has been sent or discarded by
 * a failed export (or after one fresh snapshot settles when `exportEmpty` is
 * enabled). `flush` cannot fail and respects each exporter's temporary-disable
 * window. Wrap it with `Effect.timeoutOption` to bound its duration at the call
 * site.
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
   * Each exporter runs up to its configured `concurrency` exports at a time.
   * `flush` waits for every export already in flight when called to settle and
   * drains items accepted before the call (items pushed while a flush is
   * running may be included in a batch, but `flush` does not wait for them).
   * Interrupting `flush` only stops the wait without cancelling in-flight
   * exports or dropping queued items.
   *
   * There is no built-in timeout; use `Effect.timeoutOption` to bound the
   * operation. Exporters in their 60-second `disabledUntil` window start no new
   * exports while still awaiting any export already in flight.
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
 * For each registered exporter, `flush` awaits all exports already in flight
 * when it was called and drains every item accepted before the call (or sends
 * one fresh snapshot when `exportEmpty` is enabled). Interrupting `flush` only
 * stops waiting and does not cancel in-flight exports or drop queued items.
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
 * The exporter buffers pending pushed items up to `maxQueueSize` (dropping new
 * arrivals on overflow and notifying `onDrop`), sends FIFO batches of at most
 * `maxBatchSize` with up to `concurrency` exports (including retries) in flight
 * at a time, temporarily disables exporting after unhandled failures, and
 * drains remaining items during scope finalization up to `shutdownTimeout`.
 * `maxQueueSize` bounds only pending queued items, not batches already in
 * flight.
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
    /**
     * Maximum number of pending items buffered in the queue. Does not count
     * items already dequeued into in-flight export batches. New items pushed
     * while the queue is full are dropped and reported to `onDrop`.
     *
     * Defaults to `2048` (or `maxBatchSize` if larger).
     */
    readonly maxQueueSize?: number | undefined
    /**
     * Maximum number of export requests (including retries) allowed in flight
     * concurrently, or `"unbounded"` for no limit.
     *
     * Defaults to `4`.
     */
    readonly concurrency?: Concurrency | undefined
    /**
     * Synchronous callback invoked when items are dropped due to queue overflow.
     */
    readonly onDrop?: ((count: number) => void) | undefined
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
  const batchLimit = options.maxBatchSize === "disabled" ? Infinity : Count.normalizeNonEmpty(options.maxBatchSize)
  const maxQueueSize = options.maxQueueSize === undefined || Number.isNaN(options.maxQueueSize)
    ? Number.isFinite(batchLimit) ? Math.max(2048, batchLimit) : 2048
    : Count.normalize(options.maxQueueSize)
  const concurrency = options.concurrency === "unbounded"
    ? Infinity
    : options.concurrency === undefined || Number.isNaN(options.concurrency)
    ? 4
    : Count.normalizeNonEmpty(options.concurrency)

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
  const queue = MutableList.make<any>()
  let disabledUntil: number | undefined = undefined
  let closed = false
  const isDisabled = () => {
    if (disabledUntil === undefined) return false
    if (clock.currentTimeMillisUnsafe() < disabledUntil) return true
    disabledUntil = undefined
    return false
  }
  const isStopped = () => closed || isDisabled()

  // Progress is counted in items, or in snapshots when `exportsEmpty` is set:
  // `requested` is how far callers asked to drain and `started` is how far the
  // batches dequeued so far reach. `inFlight` maps each working fiber to the
  // offset its batch starts at. Offsets only grow and a `Map` keeps insertion
  // order, so its first entry is the earliest export in flight and everything
  // before it has settled, even when batches complete out of order.
  let requested = 0
  let started = 0
  const inFlight = new Map<Fiber.Fiber<unknown, unknown>, number>()
  const settled = () => closed ? Infinity : inFlight.values().next().value ?? started

  interface Waiter {
    readonly target: number
    readonly resume: (effect: Effect.Effect<void>) => void
  }
  const waiters = new Set<Waiter>()
  const notifyWaiters = () => {
    const reached = settled()
    for (const waiter of waiters) {
      if (reached >= waiter.target) {
        waiters.delete(waiter)
        waiter.resume(Effect.void)
      }
    }
  }
  const awaitSettled = (target: number): Effect.Effect<void> =>
    Effect.callback((resume) => {
      if (settled() >= target) return resume(Effect.void)
      const waiter: Waiter = { target, resume }
      waiters.add(waiter)
      return Effect.sync(() => {
        waiters.delete(waiter)
      })
    })

  // `armed` is open while there is something to export. It changes in the
  // same synchronous step as the queue check, so a push is never stranded.
  const armed = yield* Latch.make(exportsEmpty)
  const wake = yield* Latch.make()

  const exportBatch = (items: Array<any>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const [body, onSuccess] = options.body(items)
      const batchRequest = HttpClientRequest.setBody(request, body)
      // Compress before client.execute so transient retries reuse the encoded bytes.
      const response = options.compression === "gzip"
        ? HttpClientRequest.compressBody(batchRequest, "gzip").pipe(Effect.flatMap(client.execute))
        : client.execute(batchRequest)
      return response.pipe(
        Effect.andThen(onSuccess),
        Effect.withTracerEnabled(false)
      )
    }).pipe(
      Effect.catchCause((cause) => {
        MutableList.clear(queue)
        // Nothing queued or requested will start now. Count it as started so
        // waiters only wait for the exports still in flight.
        requested = started = Math.max(started, requested)
        if (isDisabled()) return Effect.void
        disabledUntil = clock.currentTimeMillisUnsafe() + 60_000
        return Effect.logWarning("Disabling exporter for 60 seconds", cause)
      }),
      Effect.annotateLogs({
        package: "@effect/opentelemetry",
        module: options.label
      })
    )

  // Up to `concurrency` workers run on demand while there is work. The
  // exporter owns them, so interrupting a flush never cancels a request.
  const canStart = () =>
    inFlight.size < concurrency && !isStopped() && (requested > started || queue.length >= batchLimit)
  const workerLoop: Effect.Effect<void> = Effect.withFiber((fiber) => {
    if (!canStart()) return Effect.void
    const items = MutableList.takeN(queue, batchLimit)
    inFlight.set(fiber, started)
    started += exportsEmpty ? 1 : items.length
    // `exit` keeps the worker alive if the failure handler itself dies, for
    // example when a logger throws.
    return Effect.exit(exportBatch(items)).pipe(
      Effect.ensuring(Effect.sync(() => {
        inFlight.delete(fiber)
        if (inFlight.size === 0 && !exportsEmpty && queue.length === 0 && armed.closeUnsafe()) {
          wake.openUnsafe()
        }
        notifyWaiters()
      })),
      Effect.andThen(workerLoop)
    )
  })
  const runFork = Effect.runForkWith(services)
  // A worker normally claims its batch before `runFork` returns. Stop when it
  // has not, so a scheduler that yields first cannot make this loop spin.
  const startWorkers = () => {
    while (canStart() && inFlight.has(runFork(workerLoop))) {
      // keep starting workers
    }
  }

  // Exports everything accepted so far, or one fresh snapshot, and waits for
  // it to settle together with every export already in flight. During cooldown,
  // no new export starts, but any surviving in-flight export is still awaited.
  const drain: Effect.Effect<void> = Effect.suspend(() => {
    if (isStopped()) return awaitSettled(started)
    const target = started + (exportsEmpty ? 1 : queue.length)
    requested = Math.max(requested, target)
    startWorkers()
    return awaitSettled(target)
  })

  const timer = Duration.isFinite(exportInterval)
    ? runFork(Effect.gen(function*() {
      while (true) {
        wake.closeUnsafe()
        yield* armed.await
        const expired = yield* Effect.race(
          Effect.as(Effect.sleep(exportInterval), true),
          Effect.as(wake.await, false)
        )
        if (expired) yield* drain
      }
    }))
    : undefined

  // A single finalizer stops the timer, drains, then stops active workers in
  // that order even in a parallel scope. Workers are interrupted without
  // waiting for them, so shutdown ends at `shutdownTimeout` even if the HTTP
  // client is uninterruptible.
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => {
      timer?.interruptUnsafe()
      return drain.pipe(
        Effect.interruptible,
        Effect.timeoutOption(options.shutdownTimeout),
        Effect.andThen(Effect.sync(() => {
          closed = true
          MutableList.clear(queue)
          notifyWaiters()
          for (const fiber of inFlight.keys()) {
            fiber.interruptUnsafe()
          }
        }))
      )
    })
  )

  const flusher = yield* Flusher
  yield* flusher.register(drain)

  return {
    push(data) {
      // With no idle timer, the next push ends the disabled window.
      if (isStopped()) return
      if (queue.length >= maxQueueSize) {
        options.onDrop?.(1)
        return
      }
      MutableList.append(queue, data)
      if (queue.length >= batchLimit) {
        startWorkers()
      } else {
        armed.openUnsafe()
      }
    }
  }
})
