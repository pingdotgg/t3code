/**
 * Request-body gunzip (DESIGN §4, §7).
 *
 * git's remote-curl **gzips POST bodies** (`Content-Encoding: gzip`) whenever
 * the buffered body is under `http.postBuffer` (default 1 MiB) — i.e.
 * essentially every fetch negotiation request. Workers do not auto-decompress
 * request bodies, so the server must branch on `Content-Encoding: gzip` and
 * pipe through `DecompressionStream("gzip")`, sniffing the `1f 8b` magic
 * defensively (a raw pkt-line body always starts with an ASCII hex digit, so
 * the sniff can never false-positive).
 *
 * This module is the only place `DecompressionStream` is used; the pack-entry
 * zlib boundary lives in `Zlib.ts`.
 */
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { concatBytes } from "./ObjectCodec.ts";

/**
 * Error raised when a request body declared (or sniffed) as gzip fails to
 * decompress, or when the upstream body stream fails while being piped
 * through the decompressor.
 */
export class GzipBodyError extends Schema.TaggedError<GzipBodyError>()(
  "GzipBodyError",
  { reason: Schema.String },
) {}

/**
 * Returns `true` when the bytes start with the gzip magic `1f 8b`.
 */
export const sniffGzip = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/**
 * Returns `true` when a `Content-Encoding` header value declares gzip
 * (handles `gzip`, `x-gzip`, and comma-separated lists).
 */
export const isGzipContentEncoding = (value: string | undefined): boolean =>
  value !== undefined &&
  value.split(",").some((token) => {
    const t = token.trim().toLowerCase();
    return t === "gzip" || t === "x-gzip";
  });

const errorReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Pipes a byte stream through `DecompressionStream("gzip")`.
 *
 * Upstream failures propagate through the web-stream pipe and surface as
 * {@link GzipBodyError} (the typed upstream error is flattened — acceptable
 * because the caller treats any body failure the same way).
 */
export const gunzipStream = <E>(
  input: Stream.Stream<Uint8Array, E>,
): Stream.Stream<Uint8Array, GzipBodyError> =>
  Stream.fromReadableStream({
    evaluate: () =>
      Stream.toReadableStream(input).pipeThrough(
        // dom.d.ts types DecompressionStream's writable as BufferSource; the
        // runtime accepts Uint8Array chunks — bridge the variance mismatch.
        new DecompressionStream("gzip") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      ) as ReadableStream<Uint8Array>,
    onError: (error) =>
      new GzipBodyError({ reason: `gunzip failed: ${errorReason(error)}` }),
  });

/**
 * One-shot gunzip of a fully buffered body.
 */
export const gunzipBuffer = (
  data: Uint8Array,
): Effect.Effect<Uint8Array, GzipBodyError> =>
  gunzipStream(Stream.succeed(data)).pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(chunks)),
  );

/**
 * Decodes a fully buffered git request body: gunzips when `Content-Encoding`
 * says gzip **or** the body carries the `1f 8b` magic (defensive sniff —
 * pkt-line bodies always start with an ASCII hex digit, so this can never
 * misfire); otherwise returns the bytes unchanged.
 */
export const decodeGitBodyBuffer = (
  data: Uint8Array,
  contentEncoding: string | undefined,
): Effect.Effect<Uint8Array, GzipBodyError> =>
  isGzipContentEncoding(contentEncoding) || sniffGzip(data)
    ? gunzipBuffer(data)
    : Effect.succeed(data);

/**
 * Decodes a streaming git request body: when `Content-Encoding` declares
 * gzip the whole stream pipes through the decompressor; otherwise the first
 * bytes are peeked and the `1f 8b` sniff decides. Pass-through preserves the
 * upstream error type; the gunzip path surfaces failures as
 * {@link GzipBodyError}.
 */
export const decodeGitBodyStream = <E>(
  input: Stream.Stream<Uint8Array, E>,
  contentEncoding: string | undefined,
): Stream.Stream<Uint8Array, E | GzipBodyError> => {
  if (isGzipContentEncoding(contentEncoding)) {
    return gunzipStream(input);
  }
  return Stream.unwrap(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(input);
      const head: Array<Uint8Array> = [];
      let length = 0;
      let ended = false;
      while (length < 2 && !ended) {
        yield* pull.pipe(
          Effect.map((chunks) => {
            for (const chunk of chunks) {
              head.push(chunk);
              length += chunk.length;
            }
          }),
          Pull.catchDone(() =>
            Effect.sync(() => {
              ended = true;
            }),
          ),
        );
      }
      const headBytes = concatBytes(head, length);
      const remainder: Stream.Stream<Uint8Array, E> = ended
        ? Stream.empty
        : // `toPull`'s error channel is already Done-free, so ExcludeDone<E> = E;
          // TS cannot reduce the conditional for a generic E, hence the cast.
          (Stream.fromPull(Effect.succeed(pull)) as Stream.Stream<
            Uint8Array,
            E
          >);
      const full: Stream.Stream<Uint8Array, E> =
        length === 0
          ? remainder
          : Stream.concat(Stream.succeed(headBytes), remainder);
      return sniffGzip(headBytes)
        ? (gunzipStream(full) as Stream.Stream<Uint8Array, E | GzipBodyError>)
        : full;
    }),
  );
};
