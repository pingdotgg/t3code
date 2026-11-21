/**
 * OTLP Protobuf encoding for traces, metrics, and logs.
 *
 * Writes the messages of https://github.com/open-telemetry/opentelemetry-proto
 * with a `ProtobufWriter`. Each `write*` function writes the fields of one
 * message and returns the writer, so nested messages chain:
 * `writeStatus(w.tag(15, LEN).fork(), status).join()`.
 */

import * as Hex from "../../encoding/Hex.ts"
import * as ProtobufWriter from "../../protobuf/ProtobufWriter.ts"
import * as Result from "../../Result.ts"
import type { AnyValue, ArrayValue, KeyValue, KeyValueList, Resource } from "../OtlpResource.ts"
import type { ResourceSpan, ScopeSpan, TraceData } from "../OtlpTracer.ts"

type Writer = ProtobufWriter.ProtobufWriter

const VARINT = ProtobufWriter.WireType.Varint
const I64 = ProtobufWriter.WireType.I64
const LEN = ProtobufWriter.WireType.Len
const I32 = ProtobufWriter.WireType.I32

// The bytes of a hex id. An id that is not valid hex is parsed pair by pair
// with `parseInt`, and a trailing odd character is ignored.
const hexBytes = (hex: string): Uint8Array => {
  const decoded = Hex.decode(hex)
  if (Result.isSuccess(decoded)) return decoded.success
  const bytes = new Uint8Array(hex.length >>> 1)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// A log record id is a hex string or the bytes themselves.
const idBytes = (id: string | Uint8Array): Uint8Array => typeof id === "string" ? hexBytes(id) : id

// Common types (opentelemetry.proto.common.v1)

/**
 * message AnyValue {
 *   oneof value {
 *     string string_value = 1;
 *     bool bool_value = 2;
 *     int64 int_value = 3;
 *     double double_value = 4;
 *     ArrayValue array_value = 5;
 *     KeyValueList kvlist_value = 6;
 *     bytes bytes_value = 7;
 *   }
 * }
 */
const writeAnyValue = (w: Writer, value: AnyValue): Writer => {
  if (value.stringValue !== undefined && value.stringValue !== null) {
    w.tag(1, LEN).string(value.stringValue)
  } else if (value.boolValue !== undefined && value.boolValue !== null) {
    w.tag(2, VARINT).bool(value.boolValue)
  } else if (value.intValue !== undefined && value.intValue !== null) {
    w.tag(3, VARINT).int64(value.intValue)
  } else if (value.doubleValue !== undefined && value.doubleValue !== null) {
    w.tag(4, I64).double(value.doubleValue)
  } else if (value.arrayValue !== undefined) {
    writeArrayValue(w.tag(5, LEN).fork(), value.arrayValue).join()
  } else if (value.kvlistValue !== undefined) {
    writeKeyValueList(w.tag(6, LEN).fork(), value.kvlistValue).join()
  } else if (value.bytesValue !== undefined) {
    w.tag(7, LEN).bytes(value.bytesValue)
  }
  return w
}

/**
 * message ArrayValue {
 *   repeated AnyValue values = 1;
 * }
 */
const writeArrayValue = (w: Writer, value: ArrayValue): Writer => {
  for (const item of value.values) writeAnyValue(w.tag(1, LEN).fork(), item).join()
  return w
}

/**
 * message KeyValueList {
 *   repeated KeyValue values = 1;
 * }
 */
const writeKeyValueList = (w: Writer, value: KeyValueList): Writer => {
  for (const item of value.values) writeKeyValue(w.tag(1, LEN).fork(), item).join()
  return w
}

/**
 * message KeyValue {
 *   string key = 1;
 *   AnyValue value = 2;
 * }
 */
const writeKeyValue = (w: Writer, kv: KeyValue): Writer => {
  w.tag(1, LEN).string(kv.key)
  writeAnyValue(w.tag(2, LEN).fork(), kv.value).join()
  return w
}

interface InstrumentationScope {
  readonly name: string
  readonly version?: string
  readonly attributes?: ReadonlyArray<KeyValue>
  readonly droppedAttributesCount?: number
}

/**
 * message InstrumentationScope {
 *   string name = 1;
 *   string version = 2;
 *   repeated KeyValue attributes = 3;
 *   uint32 dropped_attributes_count = 4;
 * }
 */
const writeInstrumentationScope = (w: Writer, scope: InstrumentationScope): Writer => {
  w.tag(1, LEN).string(scope.name)
  if (scope.version) w.tag(2, LEN).string(scope.version)
  if (scope.attributes) { for (const item of scope.attributes) writeKeyValue(w.tag(3, LEN).fork(), item).join() }
  if (scope.droppedAttributesCount) w.tag(4, VARINT).uint32(scope.droppedAttributesCount)
  return w
}

// Resource types (opentelemetry.proto.resource.v1)

/**
 * message Resource {
 *   repeated KeyValue attributes = 1;
 *   uint32 dropped_attributes_count = 2;
 * }
 */
const writeResource = (w: Writer, resource: Resource): Writer => {
  for (const item of resource.attributes) writeKeyValue(w.tag(1, LEN).fork(), item).join()
  if (resource.droppedAttributesCount > 0) w.tag(2, VARINT).uint32(resource.droppedAttributesCount)
  return w
}

interface Status {
  readonly code: number
  readonly message?: string
}

/**
 * message Status {
 *   string message = 2;
 *   StatusCode code = 3;
 * }
 */
const writeStatus = (w: Writer, status: Status): Writer => {
  if (status.message) w.tag(2, LEN).string(status.message)
  w.tag(3, VARINT).int32(status.code)
  return w
}

interface Event {
  readonly timeUnixNano: string
  readonly name: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly droppedAttributesCount: number
}

/**
 * message Event {
 *   fixed64 time_unix_nano = 1;
 *   string name = 2;
 *   repeated KeyValue attributes = 3;
 *   uint32 dropped_attributes_count = 4;
 * }
 */
const writeEvent = (w: Writer, event: Event): Writer => {
  w.tag(1, I64).fixed64(event.timeUnixNano)
  w.tag(2, LEN).string(event.name)
  for (const item of event.attributes) writeKeyValue(w.tag(3, LEN).fork(), item).join()
  if (event.droppedAttributesCount > 0) w.tag(4, VARINT).uint32(event.droppedAttributesCount)
  return w
}

interface Link {
  readonly traceId: string
  readonly spanId: string
  readonly traceState?: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly droppedAttributesCount: number
  readonly flags?: number
}

/**
 * message Link {
 *   bytes trace_id = 1;
 *   bytes span_id = 2;
 *   string trace_state = 3;
 *   repeated KeyValue attributes = 4;
 *   uint32 dropped_attributes_count = 5;
 *   fixed32 flags = 6;
 * }
 */
const writeLink = (w: Writer, link: Link): Writer => {
  w.tag(1, LEN).bytes(hexBytes(link.traceId))
  w.tag(2, LEN).bytes(hexBytes(link.spanId))
  if (link.traceState) w.tag(3, LEN).string(link.traceState)
  for (const item of link.attributes) writeKeyValue(w.tag(4, LEN).fork(), item).join()
  if (link.droppedAttributesCount > 0) w.tag(5, VARINT).uint32(link.droppedAttributesCount)
  if (link.flags !== undefined) w.tag(6, I32).fixed32(link.flags)
  return w
}

interface Span {
  readonly traceId: string
  readonly spanId: string
  readonly traceState?: string
  readonly parentSpanId?: string | undefined
  readonly name: string
  readonly kind: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly droppedAttributesCount: number
  readonly events: ReadonlyArray<Event>
  readonly droppedEventsCount: number
  readonly links: ReadonlyArray<Link>
  readonly droppedLinksCount: number
  readonly status: Status
  readonly flags?: number
}

/**
 * message Span {
 *   bytes trace_id = 1;
 *   bytes span_id = 2;
 *   string trace_state = 3;
 *   bytes parent_span_id = 4;
 *   string name = 5;
 *   SpanKind kind = 6;
 *   fixed64 start_time_unix_nano = 7;
 *   fixed64 end_time_unix_nano = 8;
 *   repeated KeyValue attributes = 9;
 *   uint32 dropped_attributes_count = 10;
 *   repeated Event events = 11;
 *   uint32 dropped_events_count = 12;
 *   repeated Link links = 13;
 *   uint32 dropped_links_count = 14;
 *   Status status = 15;
 *   fixed32 flags = 16;
 * }
 */
const writeSpan = (w: Writer, span: Span): Writer => {
  w.tag(1, LEN).bytes(hexBytes(span.traceId))
  w.tag(2, LEN).bytes(hexBytes(span.spanId))
  if (span.traceState) w.tag(3, LEN).string(span.traceState)
  if (span.parentSpanId !== undefined) w.tag(4, LEN).bytes(hexBytes(span.parentSpanId))
  w.tag(5, LEN).string(span.name)
  w.tag(6, VARINT).int32(span.kind)
  w.tag(7, I64).fixed64(span.startTimeUnixNano)
  w.tag(8, I64).fixed64(span.endTimeUnixNano)
  for (const item of span.attributes) writeKeyValue(w.tag(9, LEN).fork(), item).join()
  if (span.droppedAttributesCount > 0) w.tag(10, VARINT).uint32(span.droppedAttributesCount)
  for (const item of span.events) writeEvent(w.tag(11, LEN).fork(), item).join()
  if (span.droppedEventsCount > 0) w.tag(12, VARINT).uint32(span.droppedEventsCount)
  for (const item of span.links) writeLink(w.tag(13, LEN).fork(), item).join()
  if (span.droppedLinksCount > 0) w.tag(14, VARINT).uint32(span.droppedLinksCount)
  writeStatus(w.tag(15, LEN).fork(), span.status).join()
  if (span.flags !== undefined) w.tag(16, I32).fixed32(span.flags)
  return w
}

/**
 * message ScopeSpans {
 *   InstrumentationScope scope = 1;
 *   repeated Span spans = 2;
 *   string schema_url = 3;
 * }
 */
const writeScopeSpans = (w: Writer, scopeSpans: ScopeSpan): Writer => {
  writeInstrumentationScope(w.tag(1, LEN).fork(), scopeSpans.scope).join()
  for (const item of scopeSpans.spans) writeSpan(w.tag(2, LEN).fork(), item).join()
  if (scopeSpans.schemaUrl) w.tag(3, LEN).string(scopeSpans.schemaUrl)
  return w
}

/**
 * message ResourceSpans {
 *   Resource resource = 1;
 *   repeated ScopeSpans scope_spans = 2;
 *   string schema_url = 3;
 * }
 */
const writeResourceSpans = (w: Writer, resourceSpans: ResourceSpan): Writer => {
  writeResource(w.tag(1, LEN).fork(), resourceSpans.resource).join()
  for (const item of resourceSpans.scopeSpans) writeScopeSpans(w.tag(2, LEN).fork(), item).join()
  if (resourceSpans.schemaUrl) w.tag(3, LEN).string(resourceSpans.schemaUrl)
  return w
}

/**
 * Encodes a TracesData message (top-level export request).
 *
 * message TracesData {
 *   repeated ResourceSpans resource_spans = 1;
 * }
 *
 * @internal
 */
export const encodeTracesData = (tracesData: TraceData): Uint8Array => {
  const w = ProtobufWriter.make()
  for (const item of tracesData.resourceSpans) writeResourceSpans(w.tag(1, LEN).fork(), item).join()
  return w.finish()
}

interface NumberDataPoint {
  readonly attributes: ReadonlyArray<KeyValue>
  readonly startTimeUnixNano?: string | undefined
  readonly timeUnixNano: string
  readonly asDouble?: number | undefined
  readonly asInt?: string | number | bigint | undefined
  readonly flags?: number | undefined
}

/**
 * message NumberDataPoint {
 *   repeated KeyValue attributes = 7;
 *   fixed64 start_time_unix_nano = 2;
 *   fixed64 time_unix_nano = 3;
 *   oneof value {
 *     double as_double = 4;
 *     sfixed64 as_int = 6;
 *   }
 *   repeated Exemplar exemplars = 5;
 *   uint32 flags = 8;
 * }
 */
const writeNumberDataPoint = (w: Writer, point: NumberDataPoint): Writer => {
  if (point.startTimeUnixNano !== undefined) w.tag(2, I64).fixed64(point.startTimeUnixNano)
  w.tag(3, I64).fixed64(point.timeUnixNano)
  if (point.asDouble !== undefined) w.tag(4, I64).double(point.asDouble)
  if (point.asInt !== undefined) w.tag(6, I64).fixed64(point.asInt)
  for (const item of point.attributes) writeKeyValue(w.tag(7, LEN).fork(), item).join()
  if (point.flags !== undefined) w.tag(8, VARINT).uint32(point.flags)
  return w
}

interface HistogramDataPoint {
  readonly attributes: ReadonlyArray<KeyValue>
  readonly startTimeUnixNano?: string | undefined
  readonly timeUnixNano: string
  readonly count: string | number | bigint
  readonly sum?: number | undefined
  readonly bucketCounts: ReadonlyArray<string | number | bigint>
  readonly explicitBounds: ReadonlyArray<number>
  readonly min?: number | undefined
  readonly max?: number | undefined
  readonly flags?: number | undefined
}

/**
 * message HistogramDataPoint {
 *   repeated KeyValue attributes = 9;
 *   fixed64 start_time_unix_nano = 2;
 *   fixed64 time_unix_nano = 3;
 *   fixed64 count = 4;
 *   optional double sum = 5;
 *   repeated fixed64 bucket_counts = 6;
 *   repeated double explicit_bounds = 7;
 *   optional double min = 11;
 *   optional double max = 12;
 *   uint32 flags = 10;
 * }
 */
const writeHistogramDataPoint = (w: Writer, point: HistogramDataPoint): Writer => {
  if (point.startTimeUnixNano !== undefined) w.tag(2, I64).fixed64(point.startTimeUnixNano)
  w.tag(3, I64).fixed64(point.timeUnixNano)
  w.tag(4, I64).fixed64(point.count)
  if (point.sum !== undefined) w.tag(5, I64).double(point.sum)
  // Bucket counts and bounds are written unpacked, one field per value
  for (let i = 0; i < point.bucketCounts.length; i++) w.tag(6, I64).fixed64(point.bucketCounts[i])
  for (let i = 0; i < point.explicitBounds.length; i++) w.tag(7, I64).double(point.explicitBounds[i])
  for (const item of point.attributes) writeKeyValue(w.tag(9, LEN).fork(), item).join()
  if (point.flags !== undefined) w.tag(10, VARINT).uint32(point.flags)
  if (point.min !== undefined) w.tag(11, I64).double(point.min)
  if (point.max !== undefined) w.tag(12, I64).double(point.max)
  return w
}

interface Gauge {
  readonly dataPoints: ReadonlyArray<NumberDataPoint>
}

/**
 * message Gauge {
 *   repeated NumberDataPoint data_points = 1;
 * }
 */
const writeGauge = (w: Writer, gauge: Gauge): Writer => {
  for (const item of gauge.dataPoints) writeNumberDataPoint(w.tag(1, LEN).fork(), item).join()
  return w
}

interface Sum {
  readonly dataPoints: ReadonlyArray<NumberDataPoint>
  readonly aggregationTemporality: number
  readonly isMonotonic: boolean
}

/**
 * message Sum {
 *   repeated NumberDataPoint data_points = 1;
 *   AggregationTemporality aggregation_temporality = 2;
 *   bool is_monotonic = 3;
 * }
 */
const writeSum = (w: Writer, sum: Sum): Writer => {
  for (const item of sum.dataPoints) writeNumberDataPoint(w.tag(1, LEN).fork(), item).join()
  w.tag(2, VARINT).int32(sum.aggregationTemporality)
  w.tag(3, VARINT).bool(sum.isMonotonic)
  return w
}

interface Histogram {
  readonly dataPoints: ReadonlyArray<HistogramDataPoint>
  readonly aggregationTemporality: number
}

/**
 * message Histogram {
 *   repeated HistogramDataPoint data_points = 1;
 *   AggregationTemporality aggregation_temporality = 2;
 * }
 */
const writeHistogram = (w: Writer, histogram: Histogram): Writer => {
  for (const item of histogram.dataPoints) writeHistogramDataPoint(w.tag(1, LEN).fork(), item).join()
  w.tag(2, VARINT).int32(histogram.aggregationTemporality)
  return w
}

interface ValueAtQuantile {
  readonly quantile: number
  readonly value: number
}

const writeValueAtQuantile = (w: Writer, q: ValueAtQuantile): Writer => {
  w.tag(1, I64).double(q.quantile)
  w.tag(2, I64).double(q.value)
  return w
}

interface SummaryDataPoint {
  readonly attributes: ReadonlyArray<KeyValue>
  readonly startTimeUnixNano?: string | undefined
  readonly timeUnixNano: string
  readonly count: string | number | bigint
  readonly sum: number
  readonly quantileValues: ReadonlyArray<ValueAtQuantile>
  readonly flags?: number | undefined
}

/**
 * message SummaryDataPoint {
 *   repeated KeyValue attributes = 7;
 *   fixed64 start_time_unix_nano = 2;
 *   fixed64 time_unix_nano = 3;
 *   fixed64 count = 4;
 *   double sum = 5;
 *   repeated ValueAtQuantile quantile_values = 6;
 *   uint32 flags = 8;
 * }
 *
 * message ValueAtQuantile {
 *   double quantile = 1;
 *   double value = 2;
 * }
 */
const writeSummaryDataPoint = (w: Writer, point: SummaryDataPoint): Writer => {
  if (point.startTimeUnixNano !== undefined) w.tag(2, I64).fixed64(point.startTimeUnixNano)
  w.tag(3, I64).fixed64(point.timeUnixNano)
  w.tag(4, I64).fixed64(point.count)
  w.tag(5, I64).double(point.sum)
  for (const item of point.quantileValues) writeValueAtQuantile(w.tag(6, LEN).fork(), item).join()
  for (const item of point.attributes) writeKeyValue(w.tag(7, LEN).fork(), item).join()
  if (point.flags !== undefined) w.tag(8, VARINT).uint32(point.flags)
  return w
}

interface Summary {
  readonly dataPoints: ReadonlyArray<SummaryDataPoint>
}

/**
 * message Summary {
 *   repeated SummaryDataPoint data_points = 1;
 * }
 */
const writeSummary = (w: Writer, summary: Summary): Writer => {
  for (const item of summary.dataPoints) writeSummaryDataPoint(w.tag(1, LEN).fork(), item).join()
  return w
}

interface Metric {
  readonly name: string
  readonly description?: string | undefined
  readonly unit?: string | undefined
  readonly gauge?: Gauge | undefined
  readonly sum?: Sum | undefined
  readonly histogram?: Histogram | undefined
  readonly summary?: Summary | undefined
}

/**
 * message Metric {
 *   string name = 1;
 *   string description = 2;
 *   string unit = 3;
 *   oneof data {
 *     Gauge gauge = 5;
 *     Sum sum = 7;
 *     Histogram histogram = 9;
 *     ExponentialHistogram exponential_histogram = 10;
 *     Summary summary = 11;
 *   }
 * }
 */
const writeMetric = (w: Writer, metric: Metric): Writer => {
  w.tag(1, LEN).string(metric.name)
  if (metric.description) w.tag(2, LEN).string(metric.description)
  if (metric.unit) w.tag(3, LEN).string(metric.unit)
  if (metric.gauge !== undefined) writeGauge(w.tag(5, LEN).fork(), metric.gauge).join()
  if (metric.sum !== undefined) writeSum(w.tag(7, LEN).fork(), metric.sum).join()
  if (metric.histogram !== undefined) writeHistogram(w.tag(9, LEN).fork(), metric.histogram).join()
  if (metric.summary !== undefined) writeSummary(w.tag(11, LEN).fork(), metric.summary).join()
  return w
}

interface ScopeMetrics {
  readonly scope: InstrumentationScope
  readonly metrics: ReadonlyArray<Metric>
  readonly schemaUrl?: string
}

/**
 * message ScopeMetrics {
 *   InstrumentationScope scope = 1;
 *   repeated Metric metrics = 2;
 *   string schema_url = 3;
 * }
 */
const writeScopeMetrics = (w: Writer, scopeMetrics: ScopeMetrics): Writer => {
  writeInstrumentationScope(w.tag(1, LEN).fork(), scopeMetrics.scope).join()
  for (const item of scopeMetrics.metrics) writeMetric(w.tag(2, LEN).fork(), item).join()
  if (scopeMetrics.schemaUrl) w.tag(3, LEN).string(scopeMetrics.schemaUrl)
  return w
}

interface ResourceMetrics {
  readonly resource: Resource
  readonly scopeMetrics: ReadonlyArray<ScopeMetrics>
  readonly schemaUrl?: string
}

/**
 * message ResourceMetrics {
 *   Resource resource = 1;
 *   repeated ScopeMetrics scope_metrics = 2;
 *   string schema_url = 3;
 * }
 */
const writeResourceMetrics = (w: Writer, resourceMetrics: ResourceMetrics): Writer => {
  writeResource(w.tag(1, LEN).fork(), resourceMetrics.resource).join()
  for (const item of resourceMetrics.scopeMetrics) writeScopeMetrics(w.tag(2, LEN).fork(), item).join()
  if (resourceMetrics.schemaUrl) w.tag(3, LEN).string(resourceMetrics.schemaUrl)
  return w
}

interface MetricsData {
  readonly resourceMetrics: ReadonlyArray<ResourceMetrics>
}

/**
 * Encodes a MetricsData message (top-level export request).
 *
 * message MetricsData {
 *   repeated ResourceMetrics resource_metrics = 1;
 * }
 *
 * @internal
 */
export const encodeMetricsData = (metricsData: MetricsData): Uint8Array => {
  const w = ProtobufWriter.make()
  for (const item of metricsData.resourceMetrics) writeResourceMetrics(w.tag(1, LEN).fork(), item).join()
  return w.finish()
}

interface LogRecord {
  readonly timeUnixNano: string
  readonly observedTimeUnixNano?: string | undefined
  readonly severityNumber?: number | undefined
  readonly severityText?: string | undefined
  readonly body?: AnyValue | undefined
  readonly attributes: ReadonlyArray<KeyValue>
  readonly droppedAttributesCount?: number | undefined
  readonly flags?: number | undefined
  readonly traceId?: string | Uint8Array | undefined
  readonly spanId?: string | Uint8Array | undefined
}

/**
 * message LogRecord {
 *   fixed64 time_unix_nano = 1;
 *   fixed64 observed_time_unix_nano = 11;
 *   SeverityNumber severity_number = 2;
 *   string severity_text = 3;
 *   AnyValue body = 5;
 *   repeated KeyValue attributes = 6;
 *   uint32 dropped_attributes_count = 7;
 *   fixed32 flags = 8;
 *   bytes trace_id = 9;
 *   bytes span_id = 10;
 * }
 */
const writeLogRecord = (w: Writer, record: LogRecord): Writer => {
  w.tag(1, I64).fixed64(record.timeUnixNano)
  if (record.severityNumber !== undefined) w.tag(2, VARINT).int32(record.severityNumber)
  if (record.severityText) w.tag(3, LEN).string(record.severityText)
  if (record.body !== undefined) writeAnyValue(w.tag(5, LEN).fork(), record.body).join()
  for (const item of record.attributes) writeKeyValue(w.tag(6, LEN).fork(), item).join()
  if (record.droppedAttributesCount !== undefined && record.droppedAttributesCount > 0) {
    w.tag(7, VARINT).uint32(record.droppedAttributesCount)
  }
  if (record.flags !== undefined) w.tag(8, I32).fixed32(record.flags)
  if (record.traceId) w.tag(9, LEN).bytes(idBytes(record.traceId))
  if (record.spanId) w.tag(10, LEN).bytes(idBytes(record.spanId))
  if (record.observedTimeUnixNano !== undefined) w.tag(11, I64).fixed64(record.observedTimeUnixNano)
  return w
}

interface ScopeLogs {
  readonly scope: InstrumentationScope
  readonly logRecords: ReadonlyArray<LogRecord>
  readonly schemaUrl?: string
}

/**
 * message ScopeLogs {
 *   InstrumentationScope scope = 1;
 *   repeated LogRecord log_records = 2;
 *   string schema_url = 3;
 * }
 */
const writeScopeLogs = (w: Writer, scopeLogs: ScopeLogs): Writer => {
  writeInstrumentationScope(w.tag(1, LEN).fork(), scopeLogs.scope).join()
  for (const item of scopeLogs.logRecords) writeLogRecord(w.tag(2, LEN).fork(), item).join()
  if (scopeLogs.schemaUrl) w.tag(3, LEN).string(scopeLogs.schemaUrl)
  return w
}

interface ResourceLogs {
  readonly resource: Resource
  readonly scopeLogs: ReadonlyArray<ScopeLogs>
  readonly schemaUrl?: string
}

/**
 * message ResourceLogs {
 *   Resource resource = 1;
 *   repeated ScopeLogs scope_logs = 2;
 *   string schema_url = 3;
 * }
 */
const writeResourceLogs = (w: Writer, resourceLogs: ResourceLogs): Writer => {
  writeResource(w.tag(1, LEN).fork(), resourceLogs.resource).join()
  for (const item of resourceLogs.scopeLogs) writeScopeLogs(w.tag(2, LEN).fork(), item).join()
  if (resourceLogs.schemaUrl) w.tag(3, LEN).string(resourceLogs.schemaUrl)
  return w
}

interface LogsData {
  readonly resourceLogs: ReadonlyArray<ResourceLogs>
}

/**
 * Encodes a LogsData message (top-level export request).
 *
 * message LogsData {
 *   repeated ResourceLogs resource_logs = 1;
 * }
 *
 * @internal
 */
export const encodeLogsData = (logsData: LogsData): Uint8Array => {
  const w = ProtobufWriter.make()
  for (const item of logsData.resourceLogs) writeResourceLogs(w.tag(1, LEN).fork(), item).join()
  return w.finish()
}
