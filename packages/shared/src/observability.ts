import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Tracer from "effect/Tracer";
import { OtlpResource, OtlpTracer, OtlpSerialization } from "effect/observability";

import { makeAsyncRotatingFileSink } from "./logging.ts";

export const OtlpProtocol = Schema.Literals(["http/json", "http/protobuf"]);
export type OtlpProtocol = typeof OtlpProtocol.Type;
export const layerOtlpSerialization = (protocol: OtlpProtocol) =>
  protocol === "http/protobuf" ? OtlpSerialization.layerProtobuf : OtlpSerialization.layerJson;

export interface SignalExport {
  readonly protocol: OtlpProtocol;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly exportIntervalMs: number;
}

/**
 * `process.runtime.*` resource attributes for a Node process, matching the
 * OpenTelemetry Node process detector. Electron embeds Node, so an Electron
 * process reports Node and names Electron in the description.
 */
export const nodeProcessRuntimeAttributes = (): Record<string, string> => ({
  "process.runtime.name": "nodejs",
  "process.runtime.version": process.versions.node,
  "process.runtime.description": process.versions.electron
    ? `Electron ${process.versions.electron}`
    : "Node.js",
});
let generatedServiceInstanceId: string | undefined;

/**
 * `service.instance.id` shared by every resource this process exports. Effect lets code
 * attributes beat `OTEL_RESOURCE_ATTRIBUTES`, so callers pass the operator's in to keep it winning.
 */
export const processServiceInstanceId = (
  operatorAttributes: Readonly<Record<string, string>> = {},
): string => {
  if (operatorAttributes["service.instance.id"]) return operatorAttributes["service.instance.id"];
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Resources are built synchronously, outside any Effect.
  generatedServiceInstanceId ??= crypto.randomUUID();
  return generatedServiceInstanceId;
};

export const DEFAULT_SIGNAL_EXPORT: SignalExport = {
  protocol: "http/json",
  headers: undefined,
  exportIntervalMs: 10_000,
};

const FLUSH_BUFFER_THRESHOLD = 256;

export type TraceAttributes = Readonly<Record<string, unknown>>;

export interface TraceRecordEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TraceRecordLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

interface BaseTraceRecord {
  readonly name: string;
  readonly kind: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<TraceRecordEvent>;
  readonly links: ReadonlyArray<TraceRecordLink>;
}

export interface EffectTraceRecord extends BaseTraceRecord {
  readonly type: "effect-span";
  readonly exit:
    | {
        readonly _tag: "Success";
      }
    | {
        readonly _tag: "Interrupted";
        readonly cause: string;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: string;
      };
}

export interface OtlpTraceRecord extends BaseTraceRecord {
  readonly type: "otlp-span";
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<{
    readonly name?: string;
    readonly version?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly status?:
    | {
        readonly code?: string;
        readonly message?: string;
      }
    | undefined;
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

function isStructuralTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value)
  );
}

export function errorTag(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      return isStructuralTag(error._tag) ? error._tag : "TaggedError";
    }
    if (error instanceof Error) {
      return isStructuralTag(error.name) ? error.name : "Error";
    }
  } catch {
    return "UnknownError";
  }
  return typeof error;
}

export function causeErrorTag(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    return errorTag(failure.value);
  }
  return cause.reasons[0]?._tag ?? "Empty";
}

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly onFlush?: (stats: TraceSinkFlushStats) => Effect.Effect<void>;
}

export interface TraceSinkFlushStats {
  readonly logicalWriteBytes: number;
  readonly count: number;
  readonly durationMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface LocalFileTracerOptions extends TraceSinkOptions {
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
}

type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];
type OtlpSpanEvent = OtlpSpan["events"][number];
type OtlpSpanLink = OtlpSpan["links"][number];
type OtlpSpanStatus = OtlpSpan["status"];

interface SerializableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly status: Tracer.SpanStatus;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly events: ReadonlyArray<
    readonly [name: string, startTime: bigint, attributes: Record<string, unknown>]
  >;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Repeated references expand once per path, so a small shared graph can grow exponentially.
const TRACE_ATTRIBUTE_MAX_NODES = 10_000;

interface NormalizeState {
  // Only the current ancestors, so a value repeated under two keys is not a cycle.
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

function enterNode(value: object, state: NormalizeState): string | undefined {
  if (state.seen.has(value)) {
    return "[Circular]";
  }
  if (state.remainingNodes <= 0) {
    return "[Truncated]";
  }
  state.remainingNodes--;
  state.seen.add(value);
  return undefined;
}

function normalizeJsonValue(value: unknown, state: NormalizeState): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    const marker = enterNode(value, state);
    if (marker) {
      return marker;
    }
    const normalized = value.map((entry) => normalizeJsonValue(entry, state));
    state.seen.delete(value);
    return normalized;
  }
  if (value instanceof Map) {
    const marker = enterNode(value, state);
    if (marker) {
      return marker;
    }
    const normalized = Object.fromEntries(
      Array.from(value.entries(), ([key, entryValue]) => [
        String(key),
        normalizeJsonValue(entryValue, state),
      ]),
    );
    state.seen.delete(value);
    return normalized;
  }
  if (value instanceof Set) {
    const marker = enterNode(value, state);
    if (marker) {
      return marker;
    }
    const normalized = Array.from(value.values(), (entry) => normalizeJsonValue(entry, state));
    state.seen.delete(value);
    return normalized;
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  const marker = enterNode(value, state);
  if (marker) {
    return marker;
  }
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeJsonValue(entryValue, state)]),
  );
  state.seen.delete(value);
  return normalized;
}

export function compactTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  const state: NormalizeState = { seen: new WeakSet(), remainingNodes: TRACE_ATTRIBUTE_MAX_NODES };
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      entries.push([key, normalizeJsonValue(value, state)]);
    }
  }
  return Object.fromEntries(entries);
}

function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (ExitRuntime.isSuccess(exit)) {
    return { _tag: "Success" };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      _tag: "Interrupted",
      cause: Cause.pretty(exit.cause),
    };
  }
  return {
    _tag: "Failure",
    cause: Cause.pretty(exit.cause),
  };
}

const TRACE_ATTRIBUTE_MAX_LENGTH = 500;
const TRACE_ATTRIBUTE_TRUNCATED_LENGTH = 200;
const TRACE_ATTRIBUTE_TRUNCATION_SUFFIX = "…[truncated]";
const ALWAYS_TRUNCATED_TRACE_ATTRIBUTES: ReadonlySet<string> = new Set(["db.query.text"]);

function truncateNestedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= TRACE_ATTRIBUTE_MAX_LENGTH
      ? value
      : `${value.slice(0, TRACE_ATTRIBUTE_MAX_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
  }
  if (Array.isArray(value)) {
    const truncated = value.map(truncateNestedValue);
    return truncated.some((entry, index) => entry !== value[index]) ? truncated : value;
  }
  if (isPlainObject(value)) {
    let truncated: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = truncateNestedValue(entry);
      if (next === entry) continue;
      truncated ??= { ...value };
      truncated[key] = next;
    }
    return truncated ?? value;
  }
  return value;
}

/** Clones only when clamping; never mutates attributes shared with other tracers. */
export function truncateTraceAttributes(attributes: TraceAttributes): TraceAttributes {
  let truncated: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" && ALWAYS_TRUNCATED_TRACE_ATTRIBUTES.has(key)) {
      if (value.length <= TRACE_ATTRIBUTE_TRUNCATED_LENGTH) continue;
      truncated ??= { ...attributes };
      truncated[key] =
        `${value.slice(0, TRACE_ATTRIBUTE_TRUNCATED_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
      continue;
    }
    const next = truncateNestedValue(value);
    if (next === value) continue;
    truncated ??= { ...attributes };
    truncated[key] = next;
  }
  return truncated ?? attributes;
}

function spanToTraceRecord(span: SerializableSpan): EffectTraceRecord {
  const status = span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>;
  const parentSpanId = Option.getOrUndefined(span.parent)?.spanId;

  return {
    type: "effect-span",
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sampled: span.sampled,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: truncateTraceAttributes(
      compactTraceAttributes(Object.fromEntries(span.attributes)),
    ),
    events: span.events.map(([name, startTime, attributes]) => ({
      name,
      timeUnixNano: String(startTime),
      attributes: truncateTraceAttributes(compactTraceAttributes(attributes)),
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: truncateTraceAttributes(compactTraceAttributes(link.attributes)),
    })),
    exit: formatTraceExit(status.exit),
  };
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  }).pipe(Effect.orDie);

  let buffer: Array<{ readonly text: string; readonly bytes: number }> = [];
  let bufferBytes = 0;
  const maxBufferBytes = Math.max(options.maxBytes, 4 * 1024 * 1024);
  const flushRequests = yield* Queue.sliding<void>(1);
  const flushSemaphore = yield* Semaphore.make(1);
  let writeFailing = false;
  let droppedCount = 0;
  let failureReported = false;
  let pendingFlushStats: TraceSinkFlushStats = {
    logicalWriteBytes: 0,
    count: 0,
    durationMs: 0,
  };

  const flushBuffered = Effect.gen(function* () {
    if (buffer.length === 0) {
      return;
    }

    const records = buffer;
    buffer = [];
    bufferBytes = 0;
    let persistedCount = 0;

    while (persistedCount < records.length) {
      const firstRecordBytes = records[persistedCount]!.bytes;
      let nextIndex = persistedCount + 1;
      let chunkBytes = firstRecordBytes;
      while (nextIndex < records.length) {
        const nextRecordBytes = records[nextIndex]!.bytes;
        if (chunkBytes + nextRecordBytes > options.maxBytes) break;
        chunkBytes += nextRecordBytes;
        nextIndex += 1;
      }

      const chunk = records
        .slice(persistedCount, nextIndex)
        .map((record) => record.text)
        .join("");
      const startedAt = performance.now();
      const written = yield* sink.write(chunk).pipe(Effect.result);
      if (Result.isFailure(written)) {
        // Drop the batch after disk failure to avoid an ever-growing retry backlog.
        writeFailing = true;
        droppedCount += records.length - persistedCount;
        return;
      }
      writeFailing = false;
      pendingFlushStats = {
        logicalWriteBytes: pendingFlushStats.logicalWriteBytes + chunkBytes,
        count: pendingFlushStats.count + nextIndex - persistedCount,
        durationMs: pendingFlushStats.durationMs + Math.max(0, performance.now() - startedAt),
      };
      persistedCount = nextIndex;
    }
  });

  const flush = flushSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const droppedAtStart = droppedCount;
        yield* flushBuffered;
        const stats = pendingFlushStats;
        pendingFlushStats = {
          logicalWriteBytes: 0,
          count: 0,
          durationMs: 0,
        };
        if (stats.count > 0 && options.onFlush) {
          yield* options.onFlush(stats).pipe(Effect.ignore);
        }
        if (droppedCount > 0 && !failureReported) {
          failureReported = true;
          yield* Effect.logWarning(
            "Trace writer could not keep up, dropping records until it recovers",
            {
              filePath: options.filePath,
            },
          );
        } else if (failureReported && !writeFailing && droppedCount === droppedAtStart) {
          yield* Effect.logInfo("Trace writes recovered", {
            filePath: options.filePath,
            droppedCount,
          });
          failureReported = false;
          droppedCount = 0;
        }
      }),
    )
    .pipe(
      // Cancelled OS writes still finish; await completion before rotation or finalizer drain.
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
      // Drop the ended makeTraceSink parent span so timed-fiber logs cannot accumulate on it.
      Effect.updateContext(Context.omit(Tracer.ParentSpan)<never>),
    );

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    Queue.take(flushRequests).pipe(
      Effect.timeoutOption(`${options.batchWindowMs} millis`),
      Effect.andThen(flush),
      Effect.forever,
    ),
  );

  return {
    filePath: options.filePath,
    push(record) {
      try {
        const text = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(text);
        if (bytes > options.maxBytes) return;
        if (bufferBytes + bytes > maxBufferBytes) {
          droppedCount++;
          return;
        }
        buffer.push({ text, bytes });
        bufferBytes += bytes;
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          Queue.offerUnsafe(flushRequests, undefined);
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => flush,
  } satisfies TraceSink;
});

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    // Cached lookup fibers retain parent spans. Traces need success status, not result payloads.
    const traceExit = ExitRuntime.isSuccess(exit) ? ExitRuntime.void : exit;
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit: traceExit,
    };
    this.delegate.end(endTime, traceExit);

    if (this.sampled) {
      this.push(spanToTraceRecord(this));
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const nextAttributes = attributes ?? {};
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
      ...(options.onFlush ? { onFlush: options.onFlush } : {}),
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(spanOptions, delegate.span(spanOptions), sink.push);
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});

const SPAN_KIND_MAP: Record<number, OtlpTraceRecord["kind"]> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

export function decodeOtlpTraceRecords(
  payload: OtlpTracer.TraceData,
): ReadonlyArray<OtlpTraceRecord> {
  const records: Array<OtlpTraceRecord> = [];

  for (const resourceSpan of payload.resourceSpans) {
    const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes ?? []);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        records.push(
          otlpSpanToTraceRecord({
            resourceAttributes,
            scopeAttributes: decodeAttributes(
              "attributes" in scopeSpan.scope && Array.isArray(scopeSpan.scope.attributes)
                ? scopeSpan.scope.attributes
                : [],
            ),
            scopeName: scopeSpan.scope.name,
            scopeVersion:
              "version" in scopeSpan.scope && typeof scopeSpan.scope.version === "string"
                ? scopeSpan.scope.version
                : undefined,
            span,
          }),
        );
      }
    }
  }

  return records;
}

function otlpSpanToTraceRecord(input: {
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scopeAttributes: Readonly<Record<string, unknown>>;
  readonly scopeName: string | undefined;
  readonly scopeVersion: string | undefined;
  readonly span: OtlpSpan;
}): OtlpTraceRecord {
  return {
    type: "otlp-span",
    name: input.span.name,
    traceId: input.span.traceId,
    spanId: input.span.spanId,
    ...(input.span.parentSpanId ? { parentSpanId: input.span.parentSpanId } : {}),
    sampled: true,
    kind: normalizeSpanKind(input.span.kind),
    startTimeUnixNano: input.span.startTimeUnixNano,
    endTimeUnixNano: input.span.endTimeUnixNano,
    durationMs:
      Number(parseBigInt(input.span.endTimeUnixNano) - parseBigInt(input.span.startTimeUnixNano)) /
      1_000_000,
    attributes: decodeAttributes(input.span.attributes),
    resourceAttributes: input.resourceAttributes,
    scope: {
      ...(input.scopeName ? { name: input.scopeName } : {}),
      ...(input.scopeVersion ? { version: input.scopeVersion } : {}),
      attributes: input.scopeAttributes,
    },
    events: decodeEvents(input.span.events),
    links: decodeLinks(input.span.links),
    status: decodeStatus(input.span.status),
  };
}

function decodeStatus(input: OtlpSpanStatus): OtlpTraceRecord["status"] {
  const code = String(input.code);
  const message = input.message;

  return {
    code,
    ...(message ? { message } : {}),
  };
}

function decodeEvents(input: ReadonlyArray<OtlpSpanEvent>): ReadonlyArray<TraceRecordEvent> {
  return input.map((current) => ({
    name: current.name,
    timeUnixNano: current.timeUnixNano,
    attributes: decodeAttributes(current.attributes),
  }));
}

function decodeLinks(input: ReadonlyArray<OtlpSpanLink>): ReadonlyArray<TraceRecordLink> {
  return input.flatMap((current) => {
    const traceId = current.traceId;
    const spanId = current.spanId;
    return {
      traceId,
      spanId,
      attributes: decodeAttributes(current.attributes),
    };
  });
}

function decodeAttributes(
  input: ReadonlyArray<OtlpResource.KeyValue>,
): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};

  for (const attribute of input) {
    entries[attribute.key] = decodeValue(attribute.value);
  }

  return truncateTraceAttributes(compactTraceAttributes(entries));
}

function decodeValue(input: OtlpResource.AnyValue | null | undefined): unknown {
  if (input == null) {
    return null;
  }
  if ("stringValue" in input) {
    return input.stringValue;
  }
  if ("boolValue" in input) {
    return input.boolValue;
  }
  if ("intValue" in input) {
    return input.intValue;
  }
  if ("doubleValue" in input) {
    return input.doubleValue;
  }
  if ("bytesValue" in input) {
    return input.bytesValue;
  }
  if (input.arrayValue) {
    return input.arrayValue.values.map((entry) => decodeValue(entry));
  }
  if (input.kvlistValue) {
    return decodeAttributes(input.kvlistValue.values);
  }
  return null;
}

function normalizeSpanKind(input: number): OtlpTraceRecord["kind"] {
  return SPAN_KIND_MAP[input] || "internal";
}

function parseBigInt(input: string): bigint {
  try {
    return BigInt(input);
  } catch {
    return 0n;
  }
}

export const OtlpHeadersFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.transformEffect({
      decode: (input) => {
        const headers: Record<string, string> = {};
        for (const pair of input.split(",")) {
          if (pair.trim() === "") {
            continue;
          }
          const separator = pair.indexOf("=");
          const key = separator === -1 ? "" : pair.slice(0, separator).trim();
          if (key === "") {
            return Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `Expected key=value but received ${JSON.stringify(pair.trim())}.`,
              }),
            );
          }
          try {
            headers[key] = decodeURIComponent(pair.slice(separator + 1).trim());
          } catch {
            return Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `Header ${JSON.stringify(key)} has a malformed percent-encoded value.`,
              }),
            );
          }
        }
        return Effect.succeed(headers);
      },
      encode: (headers) =>
        Effect.succeed(
          Object.entries(headers)
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join(","),
        ),
    }),
  ),
);
