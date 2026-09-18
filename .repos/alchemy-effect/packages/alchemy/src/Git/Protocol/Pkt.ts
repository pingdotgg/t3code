/**
 * pkt-line framing (gitprotocol-common).
 *
 * Every protocol message except raw pack bytes is a stream of pkt-lines:
 * 4 lowercase hex digits (total length INCLUDING the 4 length bytes) followed
 * by the payload. Max total length 65520 ⇒ max payload 65516.
 *
 * Special packets whose length field is not a length:
 *
 * | bytes  | meaning                                    |
 * |--------|--------------------------------------------|
 * | `0000` | flush-pkt — end of message/request/response |
 * | `0001` | delim-pkt — section separator (v2)          |
 * | `0002` | response-end-pkt (v2, stateless)            |
 *
 * Readers MUST strip an optional trailing LF from text payloads; writers
 * SHOULD append one. `ERR <msg>` payloads report in-band fatals once a 200
 * has begun.
 */
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { concatBytes, utf8Decode, utf8Encode } from "./ObjectCodec.ts";

/**
 * Maximum pkt-line payload: 65520 total − 4 length bytes.
 */
export const MAX_PKT_PAYLOAD = 65516;

/**
 * Error raised on malformed pkt-line framing (bad hex length, out-of-range
 * length, truncated payload, oversize writer payload).
 */
export class PktLineError extends Schema.TaggedError<PktLineError>()(
  "PktLineError",
  { reason: Schema.String },
) {}

/**
 * Error raised when a syntactically valid pkt-line stream contains a request
 * the protocol grammar does not allow (bad `want`/`have`/command lines,
 * unsupported arguments). Shared by `UploadPack` and `ReceivePack`.
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()(
  "ProtocolError",
  { reason: Schema.String },
) {}

/**
 * One decoded pkt-line: a data packet with its payload, or one of the three
 * special packets.
 */
export type PktLine =
  | { readonly _tag: "data"; readonly payload: Uint8Array }
  | { readonly _tag: "flush" }
  | { readonly _tag: "delim" }
  | { readonly _tag: "responseEnd" };

/** The flush packet singleton. */
export const flush: PktLine = { _tag: "flush" };
/** The delim packet singleton. */
export const delim: PktLine = { _tag: "delim" };

/** The 4 raw bytes of a flush-pkt (`0000`). */
export const flushPkt: Uint8Array = utf8Encode("0000");
/** The 4 raw bytes of a delim-pkt (`0001`). */
export const delimPkt: Uint8Array = utf8Encode("0001");

const HEX_CHARS = "0123456789abcdef";

const encodeLength = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  out[0] = HEX_CHARS.charCodeAt((n >> 12) & 0xf);
  out[1] = HEX_CHARS.charCodeAt((n >> 8) & 0xf);
  out[2] = HEX_CHARS.charCodeAt((n >> 4) & 0xf);
  out[3] = HEX_CHARS.charCodeAt(n & 0xf);
  return out;
};

/**
 * Encodes a data pkt-line around a binary payload (no LF appended). Throws
 * {@link PktLineError} when the payload exceeds {@link MAX_PKT_PAYLOAD} —
 * an internal invariant violation, since all writers cap their payloads.
 */
export const pktLine = (payload: Uint8Array): Uint8Array => {
  if (payload.length > MAX_PKT_PAYLOAD) {
    throw new PktLineError({
      reason: `pkt-line payload ${payload.length} exceeds ${MAX_PKT_PAYLOAD}`,
    });
  }
  const out = new Uint8Array(4 + payload.length);
  out.set(encodeLength(payload.length + 4), 0);
  out.set(payload, 4);
  return out;
};

/**
 * Encodes a text pkt-line, appending the conventional trailing LF when the
 * text does not already end with one.
 */
export const pktText = (text: string): Uint8Array =>
  pktLine(utf8Encode(text.endsWith("\n") ? text : `${text}\n`));

/**
 * Encodes an `ERR ` pkt-line. Usable anywhere in a response (including in
 * place of an advertisement); the client prints `remote error: <message>`
 * and aborts.
 */
export const errPkt = (message: string): Uint8Array =>
  pktText(`ERR ${message}`);

/**
 * Decodes a data pkt-line payload as UTF-8 text with the optional trailing
 * LF stripped (readers MUST strip it).
 */
export const pktPayloadText = (payload: Uint8Array): string => {
  const trimmed =
    payload.length > 0 && payload[payload.length - 1] === 0x0a
      ? payload.subarray(0, payload.length - 1)
      : payload;
  return utf8Decode(trimmed);
};

/**
 * Result of attempting to read one pkt-line at an offset.
 */
export type PktReadResult =
  | { readonly _tag: "pkt"; readonly pkt: PktLine; readonly next: number }
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "invalid"; readonly reason: string };

const hexDigit = (byte: number): number => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
};

/**
 * Attempts to read one pkt-line from `buf` at `offset` without copying.
 * Returns `incomplete` when more bytes are needed, `invalid` on malformed
 * framing, or the decoded packet and the offset of the next one.
 */
export const readPktLineAt = (
  buf: Uint8Array,
  offset: number,
): PktReadResult => {
  if (offset + 4 > buf.length) return { _tag: "incomplete" };
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const d = hexDigit(buf[offset + i]!);
    if (d === -1) {
      return {
        _tag: "invalid",
        reason: `invalid pkt-line length at offset ${offset}`,
      };
    }
    n = (n << 4) | d;
  }
  if (n === 0) return { _tag: "pkt", pkt: flush, next: offset + 4 };
  if (n === 1) return { _tag: "pkt", pkt: delim, next: offset + 4 };
  if (n === 2) {
    return { _tag: "pkt", pkt: { _tag: "responseEnd" }, next: offset + 4 };
  }
  if (n === 3) {
    return { _tag: "invalid", reason: `invalid pkt-line length 0003` };
  }
  if (n > MAX_PKT_PAYLOAD + 4) {
    return {
      _tag: "invalid",
      reason: `pkt-line length ${n} exceeds maximum 65520`,
    };
  }
  if (offset + n > buf.length) return { _tag: "incomplete" };
  return {
    _tag: "pkt",
    pkt: { _tag: "data", payload: buf.subarray(offset + 4, offset + n) },
    next: offset + n,
  };
};

/**
 * Decodes an entire buffer (from `offset`) as consecutive pkt-lines. Fails
 * with {@link PktLineError} when the buffer ends mid-packet or contains
 * malformed framing.
 */
export const decodePktLines = (
  buf: Uint8Array,
  offset = 0,
): Effect.Effect<ReadonlyArray<PktLine>, PktLineError> =>
  Effect.suspend(() => {
    const out: Array<PktLine> = [];
    let pos = offset;
    while (pos < buf.length) {
      const r = readPktLineAt(buf, pos);
      switch (r._tag) {
        case "pkt":
          out.push(r.pkt);
          pos = r.next;
          break;
        case "incomplete":
          return Effect.fail(
            new PktLineError({ reason: `truncated pkt-line at offset ${pos}` }),
          );
        case "invalid":
          return Effect.fail(new PktLineError({ reason: r.reason }));
      }
    }
    return Effect.succeed(out);
  });

const EMPTY = new Uint8Array(0);

/**
 * Stream transform: decodes a byte stream into a stream of pkt-lines,
 * buffering partial packets across chunk boundaries. Fails with
 * {@link PktLineError} on malformed framing or a truncated trailing packet.
 *
 * Note: payloads are copied out of the internal buffer so they remain valid
 * after the transform advances.
 */
export const decodePktStream = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<PktLine, E | PktLineError, R> =>
  Stream.transformPull(input, (pull) =>
    Effect.sync(() => {
      let buffer: Uint8Array = EMPTY;
      let upstreamDone = false;

      const drain = (): Array<PktLine> | PktLineError => {
        const out: Array<PktLine> = [];
        let pos = 0;
        for (;;) {
          const r = readPktLineAt(buffer, pos);
          if (r._tag === "incomplete") break;
          if (r._tag === "invalid") {
            return new PktLineError({ reason: r.reason });
          }
          // copy the payload: the backing buffer is replaced on refill
          out.push(
            r.pkt._tag === "data"
              ? { _tag: "data", payload: Uint8Array.from(r.pkt.payload) }
              : r.pkt,
          );
          pos = r.next;
        }
        buffer = pos === 0 ? buffer : buffer.subarray(pos);
        return out;
      };

      const loop: Pull.Pull<
        Arr.NonEmptyReadonlyArray<PktLine>,
        E | PktLineError,
        void
      > = Effect.suspend(() => {
        const drained = drain();
        if (drained instanceof PktLineError) return Effect.fail(drained);
        if (Arr.isReadonlyArrayNonEmpty(drained)) {
          return Effect.succeed(drained);
        }
        if (upstreamDone) {
          if (buffer.length > 0) {
            return Effect.fail(
              new PktLineError({
                reason: "byte stream ended inside a pkt-line",
              }),
            );
          }
          return Cause.done();
        }
        return pull.pipe(
          Effect.map((chunks) => {
            buffer = concatBytes([buffer, ...chunks]);
          }),
          Pull.catchDone(() =>
            Effect.sync(() => {
              upstreamDone = true;
            }),
          ),
          Effect.flatMap(() => loop),
        );
      });

      return loop;
    }),
  );
