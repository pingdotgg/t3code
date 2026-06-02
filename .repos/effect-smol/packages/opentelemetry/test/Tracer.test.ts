import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as Tracer from "@effect/opentelemetry/Tracer"
import { assert, describe, it } from "@effect/vitest"
import * as OtelApi from "@opentelemetry/api"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"

const TracingLive = NodeSdk.layer(Effect.sync(() => ({
  resource: {
    serviceName: "test"
  },
  spanProcessor: [new SimpleSpanProcessor(new InMemorySpanExporter())]
})))

// needed to test context propagation
const contextManager = new AsyncHooksContextManager()
OtelApi.context.setGlobalContextManager(contextManager)

describe("Tracer", () => {
  describe("provided", () => {
    it.effect("withSpan", () =>
      Effect.gen(function*() {
        const span = yield* Effect.currentSpan
        assert.instanceOf(span, Tracer.OtelSpan)
      }).pipe(
        Effect.withSpan("ok"),
        Effect.provide(TracingLive)
      ))

    it.effect("withSpan links", () =>
      Effect.gen(function*() {
        const linkedSpan = yield* Effect.makeSpanScoped("B")
        const span = yield* Effect.currentSpan.pipe(
          Effect.withSpan("A"),
          Effect.linkSpans(linkedSpan)
        )
        assert.instanceOf(span, Tracer.OtelSpan)
        assert.lengthOf(span.links, 1)
      }).pipe(
        Effect.scoped,
        Effect.provide(TracingLive)
      ))

    it.effect("nested withSpan sets correct parent chain", () =>
      Effect.gen(function*() {
        const child = yield* Effect.currentSpan.pipe(
          Effect.withSpan("child"),
          Effect.withSpan("parent")
        )
        assert.instanceOf(child, Tracer.OtelSpan)
        assert.strictEqual(child.name, "child")
        assert.isDefined(child.parent)
        assert.strictEqual((child.parent.valueOrUndefined! as Tracer.OtelSpan).name, "parent")
      }).pipe(
        Effect.provide(TracingLive)
      ))

    it.effect("supervisor sets context", () =>
      Effect.sync(() => {
        const context = OtelApi.context.active()
        assert.isDefined(OtelApi.trace.getSpan(context))
      }).pipe(
        Effect.withSpan("ok"),
        Effect.provide(TracingLive)
      ))

    it.effect("supervisor sets context generator", () =>
      Effect.gen(function*() {
        yield* Effect.yieldNow
        const context = OtelApi.context.active()
        assert.isDefined(OtelApi.trace.getSpan(context))
      }).pipe(
        Effect.withSpan("ok"),
        Effect.provide(TracingLive)
      ))

    it.effect("currentOtelSpan", () =>
      Effect.gen(function*() {
        const span = yield* Effect.currentSpan
        const otelSpan = yield* Tracer.currentOtelSpan
        assert.strictEqual((span as Tracer.OtelSpan).span, otelSpan)
      }).pipe(
        Effect.withSpan("ok"),
        Effect.provide(TracingLive)
      ))

    it.effect("records every pretty error", () =>
      Effect.gen(function*() {
        const exporter = new InMemorySpanExporter()
        const spanProcessor = new SimpleSpanProcessor(exporter)
        const firstFailure = Cause.fail(new Error("first"))
        const secondFailure = Cause.fail(new Error("second"))
        const cause = Cause.combine(firstFailure, secondFailure)

        yield* Effect.failCause(cause).pipe(
          Effect.withSpan("error-span"),
          Effect.andThen(Effect.never), // keep the exporter alive
          Effect.provide(NodeSdk.layer(() => ({
            resource: {
              serviceName: "test"
            },
            spanProcessor: [spanProcessor]
          }))),
          Effect.forkChild({ startImmediately: true })
        )

        const spanData = exporter.getFinishedSpans()[0]
        if (spanData === undefined) {
          return yield* Effect.die("Missing span data")
        }
        const exceptionEvents = spanData.events.filter((event) => event.name === "exception")
        assert.lengthOf(exceptionEvents, 2)
        assert.strictEqual(spanData.status.message, "first")
      }))

    it.effect("withSpanContext", () =>
      Effect.gen(function*() {
        const effect = Effect.gen(function*() {
          const span = yield* Effect.currentParentSpan
          assert(span._tag === "Span")
          if (span.parent._tag === "None") {
            return yield* Effect.die("No parent span")
          }
          return span.parent.value
        }).pipe(Effect.withSpan("child"))

        const services = yield* Effect.context<never>()

        yield* Effect.promise(async () => {
          await OtelApi.trace.getTracer("test").startActiveSpan("otel-span", {
            root: true,
            attributes: { "root": "yes" }
          }, async (span) => {
            try {
              const parent = await effect.pipe(
                Tracer.withSpanContext(span.spanContext()),
                Effect.provideContext(services),
                Effect.runPromise
              )
              const { spanId, traceId } = span.spanContext()
              assert.containsSubset(parent, {
                spanId,
                traceId
              })
            } finally {
              span.end()
            }
          })
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(TracingLive)
      ))
  })

  describe("not provided", () => {
    it.effect("withSpan", () =>
      Effect.gen(function*() {
        const span = yield* Effect.currentSpan
        assert.notInstanceOf(span, Tracer.OtelSpan)
      }).pipe(
        Effect.withSpan("ok")
      ))
  })
})
