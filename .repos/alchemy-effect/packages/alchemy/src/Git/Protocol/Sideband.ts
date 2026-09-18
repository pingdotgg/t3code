/**
 * side-band-64k multiplexing.
 *
 * When `side-band-64k` is negotiated, binary data is carried as pkt-lines
 * whose first payload byte is the band:
 *
 * - **band 1** — pack data (or the receive-pack report)
 * - **band 2** — progress messages (client prints to stderr as `remote: `)
 * - **band 3** — fatal error message; the client aborts
 *
 * Frame arithmetic: max pkt-line total 65520 = 4 length bytes + 1 band byte
 * + **65515** data bytes, so every frame carries at most 65515 payload bytes.
 * Legacy `side-band` (1000-byte packets) is never advertised.
 */
import * as Stream from "effect/Stream";
import { concatBytes, utf8Encode } from "./ObjectCodec.ts";
import { flushPkt, pktLine } from "./Pkt.ts";

/**
 * Maximum data bytes per side-band-64k frame (65520 − 4 length − 1 band).
 */
export const SIDEBAND_DATA_MAX = 65515;

/**
 * The three side-band channels.
 */
export type SidebandBand = 1 | 2 | 3;

/**
 * Encodes a single side-band frame. The data must be at most
 * {@link SIDEBAND_DATA_MAX} bytes — use {@link sidebandFrames} to split
 * arbitrary payloads.
 */
const HEX = "0123456789abcdef";

/** The 5-byte sideband frame header for `dataLength` payload bytes. */
const sidebandHeader = (band: SidebandBand, dataLength: number): Uint8Array => {
  const total = dataLength + 5;
  const out = new Uint8Array(5);
  out[0] = HEX.charCodeAt((total >> 12) & 0xf);
  out[1] = HEX.charCodeAt((total >> 8) & 0xf);
  out[2] = HEX.charCodeAt((total >> 4) & 0xf);
  out[3] = HEX.charCodeAt(total & 0xf);
  out[4] = band;
  return out;
};

export const sidebandFrame = (
  band: SidebandBand,
  data: Uint8Array,
): Uint8Array => {
  // One allocation, one copy: header + band + payload in place.
  const out = new Uint8Array(5 + data.length);
  out.set(sidebandHeader(band, data.length), 0);
  out.set(data, 5);
  return out;
};

/**
 * Splits a payload into as many side-band frames as needed (each carrying at
 * most {@link SIDEBAND_DATA_MAX} data bytes). An empty payload produces no
 * frames.
 */
export const sidebandFrames = (
  band: SidebandBand,
  data: Uint8Array,
): Array<Uint8Array> => {
  const frames: Array<Uint8Array> = [];
  for (let pos = 0; pos < data.length; pos += SIDEBAND_DATA_MAX) {
    frames.push(
      sidebandFrame(band, data.subarray(pos, pos + SIDEBAND_DATA_MAX)),
    );
  }
  return frames;
};

/**
 * Stream transform: wraps every chunk of a byte stream into side-band frames
 * on the given band. Used to mux the pack stream (band 1) into the response
 * body; the caller appends the outer flush-pkt after the wrapped stream.
 */
export const wrapSideband =
  (band: SidebandBand) =>
  <E, R>(
    stream: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<Uint8Array, E, R> =>
    Stream.flatMap(stream, (chunk) =>
      chunk.length === 0
        ? Stream.empty
        : Stream.fromArray(sidebandFrames(band, chunk)),
    );

/**
 * Encodes a band-2 progress message (e.g. `Counting objects: 42, done.`).
 * A trailing newline is appended when missing so the client's stderr stays
 * line-buffered.
 */
export const progressMessage = (message: string): Uint8Array =>
  concatBytes(
    sidebandFrames(
      2,
      utf8Encode(
        message.endsWith("\n") || message.endsWith("\r")
          ? message
          : `${message}\n`,
      ),
    ),
  );

/**
 * Encodes a band-3 fatal error message. The client prints it and aborts the
 * transfer; the server should end the response after sending it.
 */
export const sidebandError = (message: string): Uint8Array =>
  concatBytes(
    sidebandFrames(
      3,
      utf8Encode(message.endsWith("\n") ? message : `${message}\n`),
    ),
  );

/** Target bytes per native write from {@link pumpPackBody}. */
export const PUMP_READ_BYTES = 1 << 20;

/**
 * Sideband-frames a whole chunk into ONE buffer: `ceil(n / 65515)` frames,
 * each `header(5) + data`, laid out back to back. One memcpy per byte.
 */
export const sidebandFrameAll = (band: SidebandBand, data: Uint8Array) => {
  const frames = Math.ceil(data.length / SIDEBAND_DATA_MAX);
  const out = new Uint8Array(data.length + frames * 5);
  let at = 0;
  for (let pos = 0; pos < data.length; pos += SIDEBAND_DATA_MAX) {
    const end = Math.min(pos + SIDEBAND_DATA_MAX, data.length);
    out.set(sidebandHeader(band, end - pos), at);
    out.set(data.subarray(pos, end), at + 5);
    at += 5 + (end - pos);
  }
  return out;
};

/**
 * Pumps a pack body to the client through a native `IdentityTransformStream`
 * (DESIGN §22.3). Returns the response body.
 *
 * Why this shape, measured on a 40 MiB bundle (DESIGN §22.4):
 *
 * - An Effect `Stream` body tops out around 15–20 MiB/s: every chunk is a
 *   fiber round trip. The raw case is a platform-to-platform `pipeTo` —
 *   zero JS per chunk — and runs at the client's line rate (71 MiB/s here).
 * - Sideband cannot be a bare pipe: the protocol caps a frame at 65515
 *   data bytes. Writing frames one at a time into the identity stream —
 *   whether from a `TransformStream` or a manual loop — also measured
 *   ~15 MiB/s: the identity stream is unbuffered, so each `write` waits
 *   for the consumer, and 64 KiB per round trip is the ceiling.
 * - So: read ~1 MiB at a time (BYOB `readAtLeast` on byte sources, which
 *   R2 bodies are), frame the whole read into one buffer, one `write`.
 *   16× fewer round trips; one extra memcpy per byte (~1 ms/MiB).
 *
 * Errors on the source abort the writable, which errors the body the
 * client is reading — the right signal for a truncated pack.
 */
export const pumpPackBody = (options: {
  /** Bytes before the pack (NAK/ACK lines, progress) — sent as-is. */
  readonly prefix: Uint8Array;
  readonly source: ReadableStream<Uint8Array>;
  readonly sideband: boolean;
  /**
   * The source is ALREADY sideband-framed (a `bundleSidebandKey` object):
   * pipe it through natively and only append the flush packet.
   */
  readonly framed?: boolean | undefined;
}): ReadableStream<Uint8Array> => {
  const { readable, writable } = new IdentityTransformStream();
  void (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(options.prefix);
      if (!options.sideband) {
        writer.releaseLock();
        await options.source.pipeTo(writable);
        return;
      }
      if (options.framed === true) {
        writer.releaseLock();
        await options.source.pipeTo(writable, { preventClose: true });
        const tail = writable.getWriter();
        await tail.write(flushPkt);
        await tail.close();
        return;
      }
      for await (const chunk of readBig(options.source)) {
        await writer.write(sidebandFrameAll(1, chunk));
      }
      await writer.write(flushPkt);
      await writer.close();
    } catch (error) {
      await writable.abort(error).catch(() => {});
    }
  })();
  return readable;
};

/**
 * Yields chunks of about {@link PUMP_READ_BYTES} from a source: BYOB
 * `readAtLeast` (a workerd extension) fills a whole buffer per read on byte
 * streams; other streams are read as they come.
 */
async function* readBig(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = source.getReader({ mode: "byob" });
  } catch {
    byob = undefined;
  }
  if (byob === undefined) {
    const reader = source.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.length > 0) yield value;
    }
  }
  const reader = byob as ReadableStreamBYOBReader & {
    readAtLeast?: (
      min: number,
      view: Uint8Array,
    ) => Promise<ReadableStreamReadResult<Uint8Array>>;
  };
  let buffer = new ArrayBuffer(PUMP_READ_BYTES);
  for (;;) {
    const view = new Uint8Array(buffer);
    const result =
      reader.readAtLeast !== undefined
        ? await reader.readAtLeast(view.byteLength, view)
        : await reader.read(view);
    if (result.value !== undefined && result.value.byteLength > 0) {
      yield result.value;
      // The buffer was transferred into `value`; take it back for reuse.
      buffer = result.value.buffer as ArrayBuffer;
    }
    if (result.done) return;
  }
}

/** Byte length of {@link sidebandRechunk}'s output for `size` input bytes. */
export const sidebandFramedLength = (size: number): number =>
  size + 5 * Math.ceil(size / SIDEBAND_DATA_MAX);

/**
 * Re-frames a byte stream into band frames of EXACTLY
 * {@link SIDEBAND_DATA_MAX} data bytes (the last one shorter), independent
 * of how the input is chunked — so the output length is a pure function
 * of the input length ({@link sidebandFramedLength}), which an R2 put of
 * a stream needs up front. Used to write a bundle's pre-framed twin.
 */
export const sidebandRechunk =
  (band: SidebandBand) =>
  <E, R>(
    stream: Stream.Stream<Uint8Array, E, R>,
  ): Stream.Stream<Uint8Array, E, R> => {
    let carry: Uint8Array = new Uint8Array(0);
    const frames = (chunk: Uint8Array): Array<Uint8Array> => {
      const data = carry.length === 0 ? chunk : concatBytes([carry, chunk]);
      const out: Array<Uint8Array> = [];
      let pos = 0;
      while (data.length - pos >= SIDEBAND_DATA_MAX) {
        out.push(
          sidebandFrame(band, data.subarray(pos, pos + SIDEBAND_DATA_MAX)),
        );
        pos += SIDEBAND_DATA_MAX;
      }
      carry = data.slice(pos);
      return out;
    };
    return Stream.flatMap(stream, (chunk) =>
      Stream.fromArray(frames(chunk)),
    ).pipe(
      Stream.concat(
        Stream.suspend(() =>
          carry.length === 0
            ? Stream.empty
            : Stream.succeed(sidebandFrame(band, carry)),
        ),
      ),
    );
  };
