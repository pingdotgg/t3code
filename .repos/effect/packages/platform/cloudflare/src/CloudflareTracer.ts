/**
 * Records Effect spans in the trace Cloudflare Workers already collects for
 * each invocation, using the Workers custom spans API (`tracing` from
 * `cloudflare:workers`).
 *
 * Effect spans become Cloudflare spans in the invocation's trace, and the spans
 * the runtime creates for `fetch` and binding calls nest under the Effect span
 * that made them. Cloudflare exports the trace to the OpenTelemetry destinations
 * configured for the account, so there is no endpoint, exporter, or flush to
 * configure. Enable traces in the Wrangler configuration
 * (`observability.traces.enabled`) for spans to be recorded.
 *
 * Use `Otlp.layer` with `FetchHttpClient` instead to send a separate trace
 * from the Worker to your own OTLP endpoint.
 *
 * **Compatibility**
 *
 * The module imports `tracing` from `cloudflare:workers`, so it only loads in
 * the Workers runtime.
 *
 * The tracer needs `tracing.startSpan` and `tracing.withActiveSpan`.
 * `withActiveSpan` is newer than Cloudflare's custom spans documentation: it
 * shipped in workerd `1.20261113.1`, and `@cloudflare/workers-types` types it
 * from `5.20261107.1`. Local development needs a Wrangler or Miniflare release
 * that bundles that workerd or later.
 *
 * It also needs `AsyncLocalStorage` from `process.getBuiltinModule`, which
 * Workers provide with the `nodejs_compat` flag or a compatibility date of
 * `2026-08-04` or later. Building the layer fails without it.
 *
 * **Limitations**
 *
 * - Cloudflare decides a span's parent from the async context, so an Effect
 *   span created with `root: true` or with a parent from another tracer, such
 *   as an incoming `traceparent`, still nests under the active Cloudflare span.
 * - Cloudflare spans have no events, links, kind, or explicit timestamps. Span
 *   events are dropped, links and kind stay on the Effect span, and Cloudflare
 *   records the timing.
 * - A Cloudflare span belongs to the invocation that created it. An Effect span
 *   that outlives its invocation, such as a `Layer.span` in a module-level
 *   `ManagedRuntime`, stops recording, and spans created under it in later
 *   invocations nest under that invocation's root span.
 * - A Durable Object does not reject spans from its earlier requests, so there
 *   spans created under such a span join the earlier request's trace, which has
 *   already been sent, and are lost. Avoid long-lived parent spans, such as a
 *   `Layer.span`, in a runtime shared across a Durable Object's requests.
 * - Sampling is Effect's decision and recording is Cloudflare's. A span
 *   Cloudflare does not record gets random ids, so an outgoing `traceparent`
 *   can be marked sampled in an invocation Cloudflare records nothing for.
 *
 * @stability experimental
 * @since 4.1.5
 */
import { tracing } from "cloudflare:workers"
import * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Hex from "effect/encoding/Hex"
import type * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

type TracingSpan = ReturnType<typeof tracing.startSpan>

/**
 * Creates an Effect `Tracer` that records spans with the Workers `tracing`
 * API.
 *
 * **Details**
 *
 * Unsampled Effect spans, such as spans below the `MinimumTraceLevel`, create
 * no Cloudflare span, and work inside them nests under the nearest sampled
 * Effect span. An interrupted span sets the `effect.fiber.interrupted`
 * attribute; any other failure records each error as an exception and sets an
 * error status.
 *
 * Throws when `AsyncLocalStorage` is not available through
 * `process.getBuiltinModule`, as on Workers with a compatibility date before
 * `2026-08-04` and without `nodejs_compat`.
 *
 * @see {@link layer} for providing the tracer as a layer
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const make = (): Tracer.Tracer => {
  const AsyncLocalStorage = (globalThis as any).process?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage
  if (typeof AsyncLocalStorage?.snapshot !== "function") {
    throw new Error(
      "CloudflareTracer needs AsyncLocalStorage from process.getBuiltinModule. " +
        "Enable the nodejs_compat compatibility flag or use a compatibility date of 2026-08-04 or later."
    )
  }
  const snapshot = (): <A>(f: () => A) => A => AsyncLocalStorage.snapshot()

  // `withActiveSpan` is too slow to call for every primitive. Instead, each
  // fiber takes an AsyncLocalStorage snapshot with its span active, inside its
  // own async context, and re-enters it until its span changes. That context
  // stays the same for the fiber's lifetime, because the runtime restores it
  // whenever the fiber resumes, so the snapshot keeps the caller's other
  // AsyncLocalStorage values. A snapshot taken where the span was created would
  // replace them.
  const fiberEnters = new WeakMap<
    Fiber.Fiber<unknown, unknown>,
    { readonly active: TracingSpan; readonly enter: <A>(f: () => A) => A }
  >()

  // Runs `f` with the span's Cloudflare span active, for `fiber` when given.
  // Without a Cloudflare span, or with one from an earlier invocation, `f`
  // runs as it is.
  const run = <A>(span: CloudflareSpan | undefined, f: () => A, fiber?: Fiber.Fiber<unknown, unknown>): A => {
    if (span === undefined || span.active === undefined) return f()
    const active = span.active
    let entered = false
    const body = () => {
      entered = true
      return f()
    }
    try {
      if (fiber === undefined) {
        return tracing.withActiveSpan(active, body)
      }
      let cached = fiberEnters.get(fiber)
      if (cached === undefined || cached.active !== active) {
        cached = { active, enter: tracing.withActiveSpan(active, snapshot) }
        fiberEnters.set(fiber, cached)
      }
      return cached.enter(body)
    } catch (error) {
      if (entered) throw error
      // Cloudflare refused the span: it belongs to an earlier invocation.
      span.active = undefined
      return f()
    }
  }

  return Tracer.make({
    span(options) {
      const parent = Option.isSome(options.parent) && options.parent.value instanceof CloudflareSpan
        ? options.parent.value
        : undefined
      return new CloudflareSpan(
        options,
        options.sampled ? run(parent, () => tracing.startSpan(options.name)) : parent?.active
      )
    },
    context(primitive, fiber) {
      const span = fiber.cache.span
      return span instanceof CloudflareSpan
        ? run(span, () => primitive["~effect/Effect/evaluate"](fiber), fiber)
        : primitive["~effect/Effect/evaluate"](fiber)
    }
  })
}

/**
 * A layer that installs a tracer recording Effect spans with the Workers
 * `tracing` API.
 *
 * **Details**
 *
 * The tracer is created each time the layer is built, which fails with a
 * defect when `AsyncLocalStorage` is unavailable (see {@link make}).
 *
 * **Example** (Tracing a Worker)
 *
 * ```ts
 * import { CloudflareTracer } from "@effect/platform-cloudflare"
 * import { Effect, ManagedRuntime } from "effect"
 *
 * const runtime = ManagedRuntime.make(CloudflareTracer.layer)
 *
 * export default {
 *   fetch: (request: Request) =>
 *     runtime.runPromise(
 *       Effect.promise(() => fetch("https://example.com")).pipe(
 *         Effect.map((response) => new Response(response.body)),
 *         Effect.withSpan("proxy", { attributes: { "url.full": request.url } })
 *       )
 *     )
 * }
 * ```
 *
 * @see {@link make} for creating the tracer directly
 *
 * @stability experimental
 * @category layers
 * @since 4.1.5
 */
export const layer: Layer.Layer<never> = Layer.sync(Tracer.Tracer, make)

// Cloudflare gives spans it does not record all-zero ids.
const isValidId = (id: string | undefined): id is string => id !== undefined && /[^0]/.test(id)

class CloudflareSpan implements Tracer.Span {
  readonly _tag = "Span"
  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: Context.Context<never>
  readonly links: Array<Tracer.SpanLink>
  readonly kind: Tracer.SpanKind
  readonly sampled: boolean
  readonly traceId: string
  readonly spanId: string
  readonly attributes = new Map<string, unknown>()
  status: Tracer.SpanStatus
  /**
   * The Cloudflare span active while this span runs: the one it records to when
   * sampled, otherwise its nearest sampled ancestor's. Cleared once the span
   * turns out to belong to an earlier invocation.
   */
  active: TracingSpan | undefined

  constructor(options: Parameters<Tracer.Tracer["span"]>[0], active: TracingSpan | undefined) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.links = options.links
    this.kind = options.kind
    this.active = active
    // Whether Cloudflare records the span is decided per invocation, so it must
    // not leak into the sampling decision that later child spans inherit.
    this.sampled = options.sampled
    const context = options.sampled ? active?.spanContext() : undefined
    this.traceId = isValidId(context?.traceId)
      ? context.traceId
      : Option.isSome(options.parent)
      ? options.parent.value.traceId
      : Hex.random(32)
    this.spanId = isValidId(context?.spanId) ? context.spanId : Hex.random(16)
    this.status = { _tag: "Started", startTime: options.startTime }
  }

  private record(f: (span: TracingSpan) => void): void {
    if (!this.sampled || this.active === undefined) return
    try {
      f(this.active)
    } catch {
      this.active = undefined
    }
  }

  attribute(key: string, value: unknown): void {
    if (this.status._tag === "Ended") return
    this.attributes.set(key, value)
    this.record((span) => span.setAttribute(key, toAttributeValue(value)))
  }

  event(): void {}

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    if (this.status._tag === "Ended") return
    // oxlint-disable-next-line no-restricted-syntax
    this.links.push(...links)
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit }
    this.record((span) => {
      if (exit._tag === "Failure") {
        if (Cause.hasInterruptsOnly(exit.cause)) {
          span.setAttribute("effect.fiber.interrupted", true)
        } else {
          const errors = Cause.prettyErrors(exit.cause, { includeCauseInStack: true })
          for (const error of errors) {
            span.recordException(
              error.stack === undefined
                ? { name: error.name, message: error.message }
                : { name: error.name, message: error.message, stack: error.stack }
            )
          }
          if (errors.length > 0) {
            span.setStatus({ code: "error", message: errors[0].message })
          }
        }
      }
      span.end()
    })
  }
}

const toAttributeValue = (value: unknown): string | number | boolean => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  return typeof value === "bigint" ? value.toString() : Inspectable.toStringUnknown(value)
}
