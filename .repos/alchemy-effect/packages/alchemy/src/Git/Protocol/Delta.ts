/**
 * Git delta application (gitformat-pack §delta payload).
 *
 * A delta payload (after inflation) is:
 *
 * ```
 * varint(base_size) varint(result_size)   — plain 7-bit little-endian
 * instructions...
 * ```
 *
 * Instructions:
 *
 * - **Copy** (`1xxxxxxx`): bits 0–3 select which of 4 little-endian offset
 *   bytes follow; bits 4–6 which of 3 size bytes. Absent bytes are zero.
 *   **`size == 0` means `0x10000`** (the classic special case). Copies
 *   `size` bytes from `offset` in the base into the output.
 * - **Insert** (`0xxxxxxx`, x ≠ 0): the low 7 bits are the count (1–127) of
 *   literal bytes that follow; append them.
 * - `0x00` is reserved/invalid.
 *
 * Applying all instructions must produce exactly `result_size` bytes.
 *
 * Algorithm ported with attribution from isomorphic-git's `applyDelta`
 * (MIT), cross-checked against ripgit's `apply_git_delta`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeSizeVarint, ObjectParseError } from "./ObjectCodec.ts";

/**
 * Error raised on malformed delta payloads: truncated headers/instructions,
 * out-of-bounds copies, base size mismatch, or a result that does not match
 * the declared `result_size`.
 */
export class DeltaFormatError extends Schema.TaggedError<DeltaFormatError>()(
  "DeltaFormatError",
  { reason: Schema.String },
) {}

/**
 * The two size varints at the head of a delta payload, plus the offset of
 * the first instruction byte.
 */
export interface DeltaHeader {
  readonly baseSize: number;
  readonly resultSize: number;
  /** Offset of the first instruction byte. */
  readonly offset: number;
}

/**
 * Reads the `base_size`/`result_size` varint header of a delta payload.
 * Throws {@link DeltaFormatError} on truncation (pure function; use
 * {@link applyDelta} for the Effect-typed path).
 */
export const readDeltaHeader = (delta: Uint8Array): DeltaHeader => {
  try {
    const base = decodeSizeVarint(delta, 0);
    const result = decodeSizeVarint(delta, base.next);
    return {
      baseSize: base.value,
      resultSize: result.value,
      offset: result.next,
    };
  } catch (error) {
    throw error instanceof ObjectParseError
      ? new DeltaFormatError({
          reason: `truncated delta header: ${error.reason}`,
        })
      : error;
  }
};

/**
 * Applies a delta payload to its base, verifying the declared base size and
 * that the output is exactly `result_size` bytes.
 */
export const applyDelta = (
  base: Uint8Array,
  delta: Uint8Array,
): Effect.Effect<Uint8Array, DeltaFormatError> =>
  Effect.suspend(() => {
    let header: DeltaHeader;
    try {
      header = readDeltaHeader(delta);
    } catch (error) {
      return Effect.fail(
        error instanceof DeltaFormatError
          ? error
          : new DeltaFormatError({ reason: String(error) }),
      );
    }
    if (header.baseSize !== base.length) {
      return Effect.fail(
        new DeltaFormatError({
          reason: `delta base size ${header.baseSize} != actual base ${base.length}`,
        }),
      );
    }
    const out = new Uint8Array(header.resultSize);
    let outPos = 0;
    let pos = header.offset;
    while (pos < delta.length) {
      const opcode = delta[pos]!;
      pos += 1;
      if (opcode === 0) {
        return Effect.fail(
          new DeltaFormatError({ reason: "reserved delta opcode 0x00" }),
        );
      }
      if ((opcode & 0x80) !== 0) {
        // copy instruction
        let offset = 0;
        let size = 0;
        for (let bit = 0; bit < 4; bit++) {
          if ((opcode & (1 << bit)) !== 0) {
            if (pos >= delta.length) {
              return Effect.fail(
                new DeltaFormatError({ reason: "truncated copy offset" }),
              );
            }
            offset += delta[pos]! * 2 ** (8 * bit);
            pos += 1;
          }
        }
        for (let bit = 0; bit < 3; bit++) {
          if ((opcode & (1 << (4 + bit))) !== 0) {
            if (pos >= delta.length) {
              return Effect.fail(
                new DeltaFormatError({ reason: "truncated copy size" }),
              );
            }
            size += delta[pos]! * 2 ** (8 * bit);
            pos += 1;
          }
        }
        if (size === 0) size = 0x10000;
        if (offset + size > base.length) {
          return Effect.fail(
            new DeltaFormatError({
              reason: `copy out of bounds: ${offset}+${size} > base ${base.length}`,
            }),
          );
        }
        if (outPos + size > out.length) {
          return Effect.fail(
            new DeltaFormatError({
              reason: `delta output overflows declared result size ${out.length}`,
            }),
          );
        }
        out.set(base.subarray(offset, offset + size), outPos);
        outPos += size;
      } else {
        // insert instruction: opcode = literal byte count (1–127)
        const size = opcode;
        if (pos + size > delta.length) {
          return Effect.fail(
            new DeltaFormatError({ reason: "truncated insert data" }),
          );
        }
        if (outPos + size > out.length) {
          return Effect.fail(
            new DeltaFormatError({
              reason: `delta output overflows declared result size ${out.length}`,
            }),
          );
        }
        out.set(delta.subarray(pos, pos + size), outPos);
        outPos += size;
        pos += size;
      }
    }
    if (outPos !== out.length) {
      return Effect.fail(
        new DeltaFormatError({
          reason: `delta produced ${outPos} bytes, expected ${out.length}`,
        }),
      );
    }
    return Effect.succeed(out);
  });
