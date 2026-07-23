/**
 * Exports Effect spans to an OpenTelemetry Protocol (OTLP) traces endpoint.
 *
 * This module creates a `Tracer.Tracer` backed by the shared OTLP/HTTP batch
 * exporter, so Effect spans created with tracing APIs can be delivered to an
 * OpenTelemetry Collector, vendor OTLP intake, or local development collector.
 * Use `make` when you need to install the tracer manually, or `layer` when an
 * application should provide it through the Effect environment.
 *
 * Pass a concrete traces endpoint, typically `/v1/traces`, or use the
 * higher-level `Otlp` module when you want `baseUrl` path construction for all
 * observability signals. The tracer exports only ended sampled spans, converts
 * span attributes, events, links, status, parent identifiers, and failure
 * causes into OTLP trace data, and groups every batch under the configured
 * resource. Resource options are resolved through `OtlpResource`, so ensure a
 * stable `service.name` is available through options or standard OTEL resource
 * environment variables because it is also used as the instrumentation scope
 * name. Tune `exportInterval`, `maxBatchSize`, and `shutdownTimeout` for the
 * target backend and process shutdown behavior, provide `headers` for
 * authentication or routing, choose an `OtlpSerialization` layer accepted by
 * the endpoint, and use `context` only when a backend needs custom evaluation
 * around the active span.
 *
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import type * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import type * as Exit from "../../Exit.ts"
import { flow } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type * as Scope from "../../Scope.ts"
import * as Tracer from "../../Tracer.ts"
import type { ExtractTag, Mutable } from "../../Types.ts"
import type * as Headers from "../http/Headers.ts"
import type * as HttpClient from "../http/HttpClient.ts"
import * as Exporter from "./OtlpExporter.ts"
import type { KeyValue, Resource } from "./OtlpResource.ts"
import { entriesToAttributes } from "./OtlpResource.ts"
import * as OtlpResource from "./OtlpResource.ts"
import { OtlpSerialization } from "./OtlpSerialization.ts"

/**
 * Creates a `Tracer` that exports ended sampled spans to an OTLP traces endpoint.
 *
 * **Details**
 *
 * Spans are batched using the configured interval and batch size, serialized
 * with `OtlpSerialization`, and flushed when the surrounding `Scope` closes.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (
  options: {
    readonly url: string
    readonly resource?: {
      readonly serviceName?: string | undefined
      readonly serviceVersion?: string | undefined
      readonly attributes?: Record<string, unknown>
    } | undefined
    readonly headers?: Headers.Input | undefined
    readonly exportInterval?: Duration.Input | undefined
    readonly maxBatchSize?: number | undefined
    readonly context?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
    readonly shutdownTimeout?: Duration.Input | undefined
  }
) => Effect.Effect<
  Tracer.Tracer,
  never,
  OtlpSerialization | HttpClient.HttpClient | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const otelResource = yield* OtlpResource.fromConfig(options.resource)
  const serialization = yield* OtlpSerialization
  const scope: Scope = {
    name: OtlpResource.serviceNameUnsafe(otelResource)
  }

  const exporter = yield* Exporter.make({
    label: "OtlpTracer",
    url: options.url,
    headers: options.headers,
    exportInterval: options.exportInterval ?? Duration.seconds(5),
    maxBatchSize: options.maxBatchSize ?? 1000,
    body(spans) {
      const data: TraceData = {
        resourceSpans: [{
          resource: otelResource,
          scopeSpans: [{
            scope,
            spans
          }]
        }]
      }
      return serialization.traces(data)
    },
    shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3)
  })

  function exportFn(span: SpanImpl) {
    if (!span.sampled) return
    exporter.push(makeOtlpSpan(span))
  }

  return Tracer.make({
    span(options) {
      return makeSpan({
        ...options,
        status: {
          _tag: "Started",
          startTime: options.startTime
        },
        attributes: new Map(),
        export: exportFn
      })
    },
    context: options.context ?
      function(primitive, fiber) {
        if (fiber.currentSpan === undefined) {
          return primitive["~effect/Effect/evaluate"](fiber)
        }
        return options.context!(primitive, fiber.currentSpan)
      } :
      undefined
  })
})

/**
 * Provides `Tracer.Tracer` using the OTLP tracer created by `make`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: (options: {
  readonly url: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly exportInterval?: Duration.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly context?: (<X>(primitive: Tracer.EffectPrimitive<X>, span: Tracer.AnySpan) => X) | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
}) => Layer.Layer<never, never, OtlpSerialization | HttpClient.HttpClient> = flow(make, Layer.effect(Tracer.Tracer))

// internal

interface SpanImpl extends Tracer.Span {
  readonly export: (span: SpanImpl) => void
  readonly attributes: Map<string, unknown>
  readonly links: Array<Tracer.SpanLink>
  readonly events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown> | undefined]>
  status: Tracer.SpanStatus
}

const SpanProto = {
  _tag: "Span",
  end(this: SpanImpl, endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit
    }
    this.export(this)
  },
  attribute(this: SpanImpl, key: string, value: unknown) {
    this.attributes.set(key, value)
  },
  event(this: SpanImpl, name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.events.push([name, startTime, attributes])
  },
  addLinks(this: SpanImpl, links: ReadonlyArray<Tracer.SpanLink>) {
    this.links.push(...links)
  }
}
type RemainingSpanImpl = Omit<Tracer.Span, (keyof typeof SpanProto) | "traceId" | "spanId" | "events">

const makeSpan = (options: {
  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: Context.Context<never>
  readonly status: Tracer.SpanStatus
  readonly attributes: ReadonlyMap<string, unknown>
  readonly links: ReadonlyArray<Tracer.SpanLink>
  readonly kind: Tracer.SpanKind
  readonly sampled: boolean
  readonly export: (span: SpanImpl) => void
}): SpanImpl => {
  const self: Mutable<SpanImpl> = Object.assign(
    Object.create(SpanProto),
    options satisfies RemainingSpanImpl
  )
  if (Option.isSome(self.parent)) {
    self.traceId = self.parent.value.traceId
  } else {
    self.traceId = generateId(32)
  }
  self.spanId = generateId(16)
  self.events = []
  return self
}

const generateId = (len: number): string => {
  const chars = "0123456789abcdef"
  let result = ""
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

const makeOtlpSpan = (self: SpanImpl): OtlpSpan => {
  const status = self.status as ExtractTag<Tracer.SpanStatus, "Ended">
  const attributes = entriesToAttributes(self.attributes.entries())
  const events = self.events.map(([name, startTime, attributes]) => ({
    name,
    timeUnixNano: String(startTime),
    attributes: attributes
      ? entriesToAttributes(Object.entries(attributes))
      : [],
    droppedAttributesCount: 0
  }))
  let otelStatus: Status

  if (status.exit._tag === "Success") {
    otelStatus = constOtelStatusSuccess
  } else if (Cause.hasInterruptsOnly(status.exit.cause)) {
    otelStatus = {
      code: StatusCode.Ok,
      message: "Interrupted"
    }
    attributes.push({
      key: "span.label",
      value: { stringValue: "⚠︎ Interrupted" }
    }, {
      key: "status.interrupted",
      value: { boolValue: true }
    })
  } else {
    const errors = Cause.prettyErrors(status.exit.cause)
    otelStatus = {
      code: StatusCode.Error
    }
    if (errors.length > 0) {
      otelStatus.message = errors[0].message
      for (const error of errors) {
        events.push({
          name: "exception",
          timeUnixNano: String(status.endTime),
          droppedAttributesCount: 0,
          attributes: [
            {
              "key": "exception.type",
              "value": {
                "stringValue": error.name
              }
            },
            {
              "key": "exception.message",
              "value": {
                "stringValue": error.message
              }
            },
            {
              "key": "exception.stacktrace",
              "value": {
                "stringValue": error.stack ?? "No stack trace available"
              }
            }
          ]
        })
      }
    }
  }

  return {
    traceId: self.traceId,
    spanId: self.spanId,
    parentSpanId: Option.match(self.parent, {
      onNone: () => undefined,
      onSome: (parent) => parent.spanId
    }),
    name: self.name,
    kind: SpanKind[self.kind],
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    attributes,
    droppedAttributesCount: 0,
    events,
    droppedEventsCount: 0,
    status: otelStatus,
    links: self.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: entriesToAttributes(Object.entries(link.attributes)),
      droppedAttributesCount: 0
    })),
    droppedLinksCount: 0
  }
}

/**
 * Root OTLP traces payload containing spans grouped by resource.
 *
 * @category models
 * @since 4.0.0
 */
export interface TraceData {
  readonly resourceSpans: Array<ResourceSpan>
}

/**
 * Group of OTLP scope spans associated with a single resource.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResourceSpan {
  readonly resource: Resource
  readonly scopeSpans: Array<ScopeSpan>
  readonly schemaUrl?: string | undefined
}

/**
 * Group of OTLP spans emitted by a single instrumentation scope.
 *
 * @category models
 * @since 4.0.0
 */
export interface ScopeSpan {
  readonly scope: Scope
  readonly spans: Array<OtlpSpan>
  readonly schemaUrl?: string | undefined
}

interface Scope {
  readonly name: string
}

interface OtlpSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: Array<KeyValue>
  readonly droppedAttributesCount: number
  readonly events: Array<Event>
  readonly droppedEventsCount: number
  readonly status: Status
  readonly links: Array<Link>
  readonly droppedLinksCount: number
}

interface Event {
  readonly attributes: Array<KeyValue>
  readonly name: string
  readonly timeUnixNano: string
  readonly droppedAttributesCount: number
}

interface Link {
  readonly attributes: Array<KeyValue>
  readonly spanId: string
  readonly traceId: string
  readonly droppedAttributesCount: number
}

interface Status {
  readonly code: StatusCode
  message?: string
}

const StatusCode = {
  Unset: 0,
  Ok: 1,
  Error: 2
} as const

type StatusCode = typeof StatusCode[keyof typeof StatusCode]

const SpanKind = {
  unspecified: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5
} as const

const constOtelStatusSuccess: Status = {
  code: StatusCode.Ok
}
