import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { collectUint8StreamText } from "./collectUint8StreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it.effect("collects Uint8Array chunks into decoded text", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("hello "), encoder.encode("world")),
      });

      assert.deepStrictEqual(result, {
        text: "hello world",
        bytes: 11,
        truncated: false,
        invalidUtf8: false,
      });
    }),
  );

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
