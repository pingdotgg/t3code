import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { collectUint8StreamText, drainChildProcessStdio } from "./collectUint8StreamText.ts";

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

describe("drainChildProcessStdio", () => {
  it.effect("keeps every chunk after the producer ends", () =>
    Effect.gen(function* () {
      const result = yield* drainChildProcessStdio({
        stdout: Stream.make(
          encoder.encode("alpha"),
          encoder.encode("beta"),
          encoder.encode("gamma"),
          encoder.encode("tail"),
        ),
        stderr: Stream.make(encoder.encode("err")),
        exitCode: Effect.succeed(0),
      });

      assert.strictEqual(result.stdout, "alphabetagammatail");
      assert.strictEqual(result.stderr, "err");
      assert.strictEqual(result.code, 0);
    }),
  );

  it.effect("finishes draining stdout before surfacing a failed exitCode", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make("");
      const stdout = Stream.make(
        encoder.encode("one"),
        encoder.encode("two"),
        encoder.encode("three"),
      ).pipe(
        Stream.tap((chunk) =>
          Ref.update(seen, (text) => `${text}${Buffer.from(chunk).toString()}`),
        ),
      );

      const result = yield* drainChildProcessStdio({
        stdout,
        stderr: Stream.empty,
        exitCode: Effect.fail("exited"),
      }).pipe(Effect.exit);

      assert.strictEqual(yield* Ref.get(seen), "onetwothree");
      assert.strictEqual(Exit.isFailure(result), true);
    }),
  );
});
