import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { collectUint8StreamChunks, collectUint8StreamText } from "./collectStreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamChunks", () => {
  it.effect("preserves raw bytes at the limit and drains beyond it", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff]);
      const chunks = Stream.make(bytes.subarray(0, 2), bytes.subarray(2));
      const exact = yield* collectUint8StreamChunks({ stream: chunks, maxBytes: bytes.length });
      assert.deepStrictEqual(
        exact.chunks.flatMap((chunk) => [...chunk]),
        [...bytes],
      );
      assert.strictEqual(exact.bytes, bytes.length);
      assert.strictEqual(exact.truncated, false);

      let chunksRead = 0;
      const surplus = Stream.concat(chunks, Stream.make(bytes)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            chunksRead++;
          }),
        ),
      );
      const cut = yield* collectUint8StreamChunks({ stream: surplus, maxBytes: bytes.length });
      assert.deepStrictEqual(
        cut.chunks.flatMap((chunk) => [...chunk]),
        [...bytes],
      );
      assert.strictEqual(cut.bytes, bytes.length);
      assert.strictEqual(cut.truncated, true);
      assert.strictEqual(chunksRead, 3);
    }),
  );
});

describe("collectUint8StreamText", () => {
  it.effect("truncates by bytes and appends an optional marker once", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("abcdef"), encoder.encode("ghij")),
        maxBytes: 5,
        truncatedMarker: "[truncated]",
      });

      assert.deepStrictEqual(result, {
        text: "abcde[truncated]",
        bytes: 5,
        truncated: true,
        invalidUtf8: false,
      });
    }),
  );

  it.effect("reports invalid UTF-8 separately from a literal replacement character", () =>
    Effect.gen(function* () {
      const invalid = yield* collectUint8StreamText({
        stream: Stream.make(new Uint8Array([0x66, 0x80, 0x6f])),
      });
      const literal = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("before\uFFFDafter")),
      });

      assert.strictEqual(invalid.invalidUtf8, true);
      assert.strictEqual(invalid.text, "f\uFFFDo");
      assert.strictEqual(literal.invalidUtf8, false);
      assert.strictEqual(literal.text, "before\uFFFDafter");
    }),
  );
});
