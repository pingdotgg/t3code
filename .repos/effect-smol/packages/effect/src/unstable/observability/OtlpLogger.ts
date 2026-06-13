/**
 * OTLP/HTTP log exporter for Effect's logging system.
 *
 * This module turns Effect log entries into OTLP log records and sends them to
 * a logs endpoint such as an OpenTelemetry Collector or vendor OTLP intake. It
 * is the signal-specific logger used by the higher-level `Otlp` module when an
 * application wants logs, metrics, and traces configured together.
 *
 * **Mental model**
 *
 * Each call to Effect logging APIs becomes one OTLP log record. The logger
 * serializes the message body, severity, timestamp, fiber id, log annotations,
 * failure cause, and current trace/span identifiers. Active log spans are
 * exported as duration attributes named `logSpan.<label>` unless
 * `excludeLogSpans` is enabled.
 *
 * **Common tasks**
 *
 * - Use `layer` to install the logger in an application; it merges with
 *   existing loggers by default.
 * - Use `make` when composing a custom `Logger` or logger layer manually.
 * - Pass the concrete `/v1/logs` endpoint, or use `Otlp` when a shared
 *   `baseUrl` should construct all signal paths.
 * - Provide `headers` for collector authentication or routing, and choose an
 *   `OtlpSerialization` layer accepted by the endpoint.
 *
 * **Gotchas**
 *
 * Batches are flushed on `exportInterval`, when `maxBatchSize` is reached, and
 * during scope finalization up to `shutdownTimeout`. Resource options are
 * attached to every export and override OpenTelemetry resource environment
 * variables, so ensure a stable `service.name` is available through options,
 * `OTEL_RESOURCE_ATTRIBUTES`, or `OTEL_SERVICE_NAME`.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import { Clock } from "../../Clock.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import type * as Layer from "../../Layer.ts"
import * as Logger from "../../Logger.ts"
import type * as LogLevel from "../../LogLevel.ts"
import { CurrentLogAnnotations, CurrentLogSpans } from "../../References.ts"
import type * as Scope from "../../Scope.ts"
import type * as Headers from "../http/Headers.ts"
import type * as HttpClient from "../http/HttpClient.ts"
import * as Exporter from "./OtlpExporter.ts"
import type { AnyValue, Fixed64, KeyValue, Resource } from "./OtlpResource.ts"
import * as OtlpResource from "./OtlpResource.ts"
import { OtlpSerialization } from "./OtlpSerialization.ts"

/**
 * Creates an Effect `Logger` that exports log records through OTLP.
 *
 * **Details**
 *
 * The logger serializes records with the configured resource, sends them
 * through the OTLP exporter, and requires `Scope` so pending records can be
 * flushed on shutdown.
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
    readonly shutdownTimeout?: Duration.Input | undefined
    readonly excludeLogSpans?: boolean | undefined
  }
) => Effect.Effect<
  Logger.Logger<unknown, void>,
  never,
  OtlpSerialization | HttpClient.HttpClient | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const serialization = yield* OtlpSerialization
  const otelResource = yield* OtlpResource.fromConfig(options.resource)
  const scope: IInstrumentationScope = {
    name: OtlpResource.serviceNameUnsafe(otelResource)
  }

  const exporter = yield* Exporter.make({
    label: "OtlpLogger",
    url: options.url,
    headers: options.headers,
    maxBatchSize: options.maxBatchSize ?? 1000,
    exportInterval: options.exportInterval ?? Duration.seconds(1),
    body: (data) =>
      serialization.logs({
        resourceLogs: [{
          resource: otelResource,
          scopeLogs: [{
            scope,
            logRecords: data
          }]
        }]
      }),
    shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3)
  })

  const opts = {
    excludeLogSpans: options.excludeLogSpans ?? false,
    clock: yield* Clock
  }
  return Logger.make((options) => {
    exporter.push(makeLogRecord(options, opts))
  })
})

/**
 * Layer that installs the OTLP logger created by `make`.
 *
 * **Details**
 *
 * By default the OTLP logger is merged with any existing loggers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly url: string
  readonly resource?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown>
  } | undefined
  readonly headers?: Headers.Input | undefined
  readonly exportInterval?: Duration.Input | undefined
  readonly maxBatchSize?: number | undefined
  readonly shutdownTimeout?: Duration.Input | undefined
  readonly excludeLogSpans?: boolean | undefined
  readonly mergeWithExisting?: boolean | undefined
}): Layer.Layer<never, never, HttpClient.HttpClient | OtlpSerialization> =>
  Logger.layer([make(options)], {
    mergeWithExisting: options.mergeWithExisting ?? true
  })

/**
 * OTLP logs payload serialized by `OtlpLogger`.
 *
 * @category models
 * @since 4.0.0
 */
export interface LogsData {
  resourceLogs: ReadonlyArray<IResourceLogs>
}

// internal

const makeLogRecord = (options: Logger.Options<unknown>, opts: {
  readonly excludeLogSpans: boolean
  readonly clock: Clock
}): ILogRecord => {
  const now = opts.clock.currentTimeNanosUnsafe()
  const nanosString = now.toString()
  const nowMillis = options.date.getTime()

  const attributes = OtlpResource.entriesToAttributes(Object.entries(options.fiber.getRef(CurrentLogAnnotations)))
  attributes.push({
    key: "fiberId",
    value: { intValue: options.fiber.id }
  })
  if (!opts.excludeLogSpans) {
    for (const [label, startTime] of options.fiber.getRef(CurrentLogSpans)) {
      attributes.push({
        key: `logSpan.${label}`,
        value: { stringValue: `${nowMillis - startTime}ms` }
      })
    }
  }
  if (options.cause.reasons.length > 0) {
    attributes.push({
      key: "log.error",
      value: { stringValue: Cause.pretty(options.cause) }
    })
  }

  const message = Arr.ensure(options.message)

  const logRecord: ILogRecord = {
    severityNumber: logLevelToSeverityNumber(options.logLevel),
    severityText: options.logLevel,
    timeUnixNano: nanosString,
    observedTimeUnixNano: nanosString,
    attributes,
    body: OtlpResource.unknownToAttributeValue(message.length === 1 ? message[0] : message),
    droppedAttributesCount: 0
  }

  if (options.fiber.currentSpan) {
    logRecord.traceId = options.fiber.currentSpan.traceId
    logRecord.spanId = options.fiber.currentSpan.spanId
  }

  return logRecord
}

/** Properties of an InstrumentationScope. */
interface IInstrumentationScope {
  /** InstrumentationScope name */
  name: string
  /** InstrumentationScope version */
  version?: string
  /** InstrumentationScope attributes */
  attributes?: Array<KeyValue>
  /** InstrumentationScope droppedAttributesCount */
  droppedAttributesCount?: number
}
/** Properties of a ResourceLogs. */
interface IResourceLogs {
  /** ResourceLogs resource */
  resource?: Resource
  /** ResourceLogs scopeLogs */
  scopeLogs: Array<IScopeLogs>
  /** ResourceLogs schemaUrl */
  schemaUrl?: string
}
/** Properties of an ScopeLogs. */
interface IScopeLogs {
  /** IScopeLogs scope */
  scope?: IInstrumentationScope
  /** IScopeLogs logRecords */
  logRecords?: Array<ILogRecord>
  /** IScopeLogs schemaUrl */
  schemaUrl?: string | null
}
/** Properties of a LogRecord. */
interface ILogRecord {
  /** LogRecord timeUnixNano */
  timeUnixNano: Fixed64
  /** LogRecord observedTimeUnixNano */
  observedTimeUnixNano: Fixed64
  /** LogRecord severityNumber */
  severityNumber?: ESeverityNumber
  /** LogRecord severityText */
  severityText?: string
  /** LogRecord body */
  body?: AnyValue
  /** LogRecord attributes */
  attributes: Array<KeyValue>
  /** LogRecord droppedAttributesCount */
  droppedAttributesCount: number
  /** LogRecord flags */
  flags?: number
  /** LogRecord traceId */
  traceId?: string | Uint8Array
  /** LogRecord spanId */
  spanId?: string | Uint8Array
}

const logLevelToSeverityNumber = (logLevel: LogLevel.LogLevel): ESeverityNumber => {
  switch (logLevel) {
    case "Trace":
      return ESeverityNumber.SEVERITY_NUMBER_TRACE
    case "Debug":
      return ESeverityNumber.SEVERITY_NUMBER_DEBUG
    case "Info":
      return ESeverityNumber.SEVERITY_NUMBER_INFO
    case "Warn":
      return ESeverityNumber.SEVERITY_NUMBER_WARN
    case "Error":
      return ESeverityNumber.SEVERITY_NUMBER_ERROR
    case "Fatal":
      return ESeverityNumber.SEVERITY_NUMBER_FATAL
    default:
      return ESeverityNumber.SEVERITY_NUMBER_UNSPECIFIED
  }
}

/**
 * Numerical value of the severity, normalized to values described in Log Data Model.
 */
const ESeverityNumber = {
  /** Unspecified. Do NOT use as default */
  SEVERITY_NUMBER_UNSPECIFIED: 0,
  SEVERITY_NUMBER_TRACE: 1,
  SEVERITY_NUMBER_TRACE2: 2,
  SEVERITY_NUMBER_TRACE3: 3,
  SEVERITY_NUMBER_TRACE4: 4,
  SEVERITY_NUMBER_DEBUG: 5,
  SEVERITY_NUMBER_DEBUG2: 6,
  SEVERITY_NUMBER_DEBUG3: 7,
  SEVERITY_NUMBER_DEBUG4: 8,
  SEVERITY_NUMBER_INFO: 9,
  SEVERITY_NUMBER_INFO2: 10,
  SEVERITY_NUMBER_INFO3: 11,
  SEVERITY_NUMBER_INFO4: 12,
  SEVERITY_NUMBER_WARN: 13,
  SEVERITY_NUMBER_WARN2: 14,
  SEVERITY_NUMBER_WARN3: 15,
  SEVERITY_NUMBER_WARN4: 16,
  SEVERITY_NUMBER_ERROR: 17,
  SEVERITY_NUMBER_ERROR2: 18,
  SEVERITY_NUMBER_ERROR3: 19,
  SEVERITY_NUMBER_ERROR4: 20,
  SEVERITY_NUMBER_FATAL: 21,
  SEVERITY_NUMBER_FATAL2: 22,
  SEVERITY_NUMBER_FATAL3: 23,
  SEVERITY_NUMBER_FATAL4: 24
} as const

type ESeverityNumber = typeof ESeverityNumber[keyof typeof ESeverityNumber]
