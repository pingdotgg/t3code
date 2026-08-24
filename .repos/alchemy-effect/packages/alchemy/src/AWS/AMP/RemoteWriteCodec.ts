/**
 * Pure encoding helpers for the Prometheus remote-write wire format.
 *
 * Remote-write bodies are a `prometheus.WriteRequest` protobuf message,
 * snappy-compressed (raw block format). Both encodings are small and fully
 * specified, so they are hand-rolled here rather than pulling in protobuf +
 * snappy dependencies:
 *
 * ```proto
 * message WriteRequest { repeated TimeSeries timeseries = 1; }
 * message TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
 * message Label        { string name = 1; string value = 2; }
 * message Sample       { double value = 1; int64 timestamp = 2; }
 * ```
 *
 * The snappy encoder emits literal-only blocks (no back-references), which is
 * valid snappy — decoders don't require compressed output. Remote-write
 * payloads are small enough that the size cost is irrelevant.
 *
 * NOT exported from `index.ts` — internal to the RemoteWrite binding.
 */

/** One sample of a series being remote-written; timestamp in epoch millis. */
export interface EncodableSample {
  value: number;
  timestamp: number;
}

/** One fully-resolved time series: sorted-ready labels plus samples. */
export interface EncodableSeries {
  /** Complete label set INCLUDING `__name__`. */
  labels: Record<string, string>;
  samples: EncodableSample[];
}

const textEncoder = new TextEncoder();

const pushVarint = (out: number[], value: number | bigint) => {
  let v = BigInt(value);
  if (v < 0n) {
    // int64 negative values are 10-byte two's-complement varints.
    v &= 0xffffffffffffffffn;
  }
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
};

const pushLengthDelimited = (
  out: number[],
  fieldNumber: number,
  payload: ArrayLike<number>,
) => {
  out.push((fieldNumber << 3) | 2);
  pushVarint(out, payload.length);
  for (let i = 0; i < payload.length; i++) {
    out.push(payload[i]!);
  }
};

const encodeLabel = (name: string, value: string): number[] => {
  const out: number[] = [];
  pushLengthDelimited(out, 1, textEncoder.encode(name));
  pushLengthDelimited(out, 2, textEncoder.encode(value));
  return out;
};

const float64Buffer = new DataView(new ArrayBuffer(8));

const encodeSample = (sample: EncodableSample): number[] => {
  const out: number[] = [];
  // field 1: double value (wire type 1, fixed64, little-endian)
  out.push(0x09);
  float64Buffer.setFloat64(0, sample.value, true);
  for (let i = 0; i < 8; i++) {
    out.push(float64Buffer.getUint8(i));
  }
  // field 2: int64 timestamp (wire type 0, varint)
  out.push(0x10);
  pushVarint(out, Math.round(sample.timestamp));
  return out;
};

const encodeTimeSeries = (series: EncodableSeries): number[] => {
  const out: number[] = [];
  // Remote-write requires labels sorted by name.
  const names = Object.keys(series.labels).sort();
  for (const name of names) {
    pushLengthDelimited(out, 1, encodeLabel(name, series.labels[name]!));
  }
  for (const sample of series.samples) {
    pushLengthDelimited(out, 2, encodeSample(sample));
  }
  return out;
};

/** Encode a `prometheus.WriteRequest` protobuf message. */
export const encodeWriteRequest = (
  timeseries: readonly EncodableSeries[],
): Uint8Array => {
  const out: number[] = [];
  for (const series of timeseries) {
    pushLengthDelimited(out, 1, encodeTimeSeries(series));
  }
  return Uint8Array.from(out);
};

/**
 * Snappy-compress `input` using the raw block format with literal-only
 * elements: `varint(len(input))` followed by literal chunks of at most 64 KiB
 * each. Valid snappy per the format spec (compression is optional).
 */
export const snappyCompress = (input: Uint8Array): Uint8Array => {
  const header: number[] = [];
  pushVarint(header, input.length);

  const chunkSize = 65536;
  const chunkCount = Math.ceil(input.length / chunkSize);
  // Each chunk's literal tag: 1 byte for len <= 60, else 1 tag + 2 length bytes.
  let totalLength = header.length;
  for (let i = 0; i < chunkCount; i++) {
    const len = Math.min(chunkSize, input.length - i * chunkSize);
    totalLength += (len <= 60 ? 1 : 3) + len;
  }

  const out = new Uint8Array(totalLength);
  out.set(header, 0);
  let offset = header.length;
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const len = Math.min(chunkSize, input.length - start);
    if (len <= 60) {
      out[offset++] = (len - 1) << 2;
    } else {
      // tag 61: literal with 2-byte little-endian (length - 1).
      out[offset++] = 61 << 2;
      out[offset++] = (len - 1) & 0xff;
      out[offset++] = ((len - 1) >> 8) & 0xff;
    }
    out.set(input.subarray(start, start + len), offset);
    offset += len;
  }
  return out;
};
