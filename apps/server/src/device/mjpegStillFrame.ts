/**
 * Browsers paint a multipart/x-mixed-replace part only once the next part begins, and the hub
 * writes a part only when the screen changes. Left alone, an `<img>` viewer never shows a still
 * screen (clients such as the iOS app then give up waiting for the first frame) and always hides
 * the last frame of a change. Re-sending the last part after a short quiet period makes it paint.
 */
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export const STILL_FRAME_DELAY = Duration.millis(100);

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;
// Simulator frames are far smaller; a larger claim is unknown framing, not something to retain.
const MAX_PART_BYTES = 16 * 1024 * 1024;

type Part = Arr.NonEmptyReadonlyArray<Uint8Array>;

const partLength = (headers: string) => {
  if (!headers.startsWith("--")) return undefined;
  const length = Number(/^content-length:\s*(\d+)\s*$/im.exec(headers)?.[1]);
  return length <= MAX_PART_BYTES ? length : undefined;
};

const endsWithCrlf = (part: Part) => {
  const last = Arr.lastNonEmpty(part);
  const cr = last.length > 1 ? last.at(-2) : part.at(-2)?.at(-1);
  return cr === 0x0d && last.at(-1) === 0x0a;
};

/**
 * Follows the hub's part framing (`--frame`, `Content-Length`, CRLF CRLF, body, CRLF; each part
 * is one write) and keeps the last complete part as views into the forwarded chunks, so frame
 * bytes are never copied. Any other framing turns tracking off and the rest passes through.
 */
const partTracker = () => {
  let pieces: Array<Uint8Array> = [];
  let size = 0;
  let partEnd: number | null = null;
  let tracking = true;
  return {
    /** The last complete part, while the stream sits at a part boundary. */
    still: null as Part | null,
    feed(chunk: Uint8Array) {
      if (!tracking) return;
      let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let part: Part | undefined;
      while (rest.length > 0) {
        if (partEnd === null) {
          // A header split across chunks is re-scanned per chunk. Only a header-sized
          // prefix of the new chunk joins the scan, so frame bytes are never copied.
          const head =
            size === 0
              ? rest
              : Buffer.concat([...pieces, rest.subarray(0, MAX_HEADER_BYTES + HEADER_END.length)]);
          const headerEnd = head.indexOf(HEADER_END);
          if (headerEnd < 0 && head.length <= MAX_HEADER_BYTES) {
            pieces.push(rest);
            size += rest.length;
            break;
          }
          const length =
            headerEnd < 0 || headerEnd > MAX_HEADER_BYTES
              ? undefined
              : partLength(head.subarray(0, headerEnd).toString("latin1"));
          if (length === undefined) {
            tracking = false;
            break;
          }
          partEnd = headerEnd + HEADER_END.length + length + 2;
        }
        const taken = rest.subarray(0, partEnd - size);
        pieces.push(taken);
        size += taken.length;
        rest = rest.subarray(taken.length);
        if (size < partEnd) break;
        const complete = pieces;
        if (!Arr.isArrayNonEmpty(complete) || !endsWithCrlf(complete)) {
          tracking = false;
          break;
        }
        part = complete;
        pieces = [];
        size = 0;
        partEnd = null;
      }
      if (!tracking) pieces = [];
      this.still = tracking && size === 0 ? (part ?? this.still) : null;
    },
  };
};

/** Re-sends the latest frame once when the stream goes quiet between frames. */
export const repeatStillFrame = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
  Stream.transformPull(body, (pull, scope) =>
    Effect.sync(() => {
      const tracker = partTracker();
      let pending: Fiber.Fiber<Effect.Success<typeof pull>, Effect.Error<typeof pull>> | null =
        null;
      const forward = (chunks: Effect.Success<typeof pull>) => {
        pending = null;
        for (const chunk of chunks) tracker.feed(chunk);
        return chunks;
      };
      return Effect.gen(function* () {
        const still = tracker.still;
        if (still === null && pending === null) return forward(yield* pull);
        pending ??= yield* Effect.forkIn(pull, scope);
        if (still === null) return forward(yield* Fiber.join(pending));
        // Timing out the join leaves the pull running, so a frame arriving mid-wait is kept.
        const next = yield* Fiber.join(pending).pipe(Effect.timeoutOption(STILL_FRAME_DELAY));
        if (Option.isSome(next)) return forward(next.value);
        tracker.still = null;
        return still;
      });
    }),
  );
