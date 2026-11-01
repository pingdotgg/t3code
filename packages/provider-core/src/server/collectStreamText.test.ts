import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { collectUint8StreamText } from "./collectStreamText.ts";

const encoder = new TextEncoder();

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

  it.effect("decodes ANSI-encoded output with the given legacy encoding", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "caf\u00e9");
      assert.strictEqual(result.invalidUtf8, true);
    }),
  );

  it.effect("keeps a truncated multi-byte character a replacement character", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("caf\u00e9"), encoder.encode("  next")),
        maxBytes: 4,
        truncatedMarker: "[truncated]",
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "caf\uFFFD[truncated]");
      assert.strictEqual(result.invalidUtf8, true);
    }),
  );

  it.effect("decodes truncated ANSI output, not just its cut tail", () =>
    Effect.gen(function* () {
      // "Café título" in windows-1252, cut before its last letter.
      const ansi = new Uint8Array([
        0x43, 0x61, 0x66, 0xe9, 0x20, 0x74, 0xed, 0x74, 0x75, 0x6c, 0x6f,
      ]);
      const result = yield* collectUint8StreamText({
        stream: Stream.make(ansi, encoder.encode(" rest")),
        maxBytes: ansi.byteLength,
        truncatedMarker: "[truncated]",
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "Caf\u00e9 t\u00edtulo[truncated]");
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.invalidUtf8, true);
    }),
  );

  it.effect("keeps ANSI text when a legacy byte sits inside a truncated buffer", () =>
    Effect.gen(function* () {
      // "café!" in windows-1252, cut by our own byte limit.
      const ansi = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]);
      const result = yield* collectUint8StreamText({
        stream: Stream.make(ansi, encoder.encode(" more")),
        maxBytes: ansi.byteLength,
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "caf\u00e9!");
      assert.strictEqual(result.truncated, true);
    }),
  );

  it.effect("keeps ANSI bytes that cannot start the UTF-8 sequence they look like", () =>
    Effect.gen(function* () {
      // "à€" in windows-1252: e0 is a three-byte lead, but e0 80 is not a valid prefix of one.
      const ansi = new Uint8Array([0xe0, 0x80]);
      const result = yield* collectUint8StreamText({
        stream: Stream.make(ansi, encoder.encode(" more")),
        maxBytes: ansi.byteLength,
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "\u00e0\u20ac");
      assert.strictEqual(result.truncated, true);
    }),
  );

  it.effect("still treats a cut four-byte character as incomplete", () =>
    Effect.gen(function* () {
      const cut = new Uint8Array([0x68, 0x69, 0xf0, 0x9f, 0x92]);
      const result = yield* collectUint8StreamText({
        stream: Stream.make(cut, encoder.encode(" more")),
        maxBytes: cut.byteLength,
        truncatedMarker: "[truncated]",
        legacyEncoding: "windows-1252",
      });

      assert.strictEqual(result.text, "hi\uFFFD[truncated]");
    }),
  );
});
