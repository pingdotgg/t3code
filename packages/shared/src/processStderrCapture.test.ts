import { describe, expect, it } from "vite-plus/test";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_LINES,
  drainProcessStderrCapture,
  makeProcessStderrCapture,
  splitLinesWithBoundedRemainder,
} from "./processStderrCapture.ts";

const encoder = new TextEncoder();

describe("makeProcessStderrCapture", () => {
  it("splits generic streams with a bounded incomplete remainder", () => {
    expect(splitLinesWithBoundedRemainder("hel", "lo\nworld", 20)).toEqual({
      lines: ["hello"],
      remainder: "world",
      truncated: false,
    });
    expect(splitLinesWithBoundedRemainder("", "abcdefghijklmnop", 8)).toEqual({
      lines: [],
      remainder: "ijklmnop",
      truncated: true,
    });
  });

  it("splits on newlines and strips trailing carriage returns", () => {
    const capture = makeProcessStderrCapture();
    expect(capture.pushText("hello\r\nworld\n")).toEqual(["hello", "world"]);
    expect(capture.getTail()).toBe("hello\nworld");
    expect(capture.getLines()).toEqual(["hello", "world"]);
  });

  it("keeps incomplete lines until a newline or flush", () => {
    const capture = makeProcessStderrCapture();
    expect(capture.pushText("partial")).toEqual([]);
    // Incomplete remainder is still visible via getTail for crash diagnostics.
    expect(capture.getTail()).toBe("partial");
    expect(capture.pushText("-line\nnext")).toEqual(["partial-line"]);
    expect(capture.getTail()).toBe("partial-line\nnext");
    expect(capture.flush()).toBe("next");
    expect(capture.getTail()).toBe("partial-line\nnext");
    expect(capture.getLines()).toEqual(["partial-line", "next"]);
  });

  it("bounds by maxLines", () => {
    const capture = makeProcessStderrCapture({ maxLines: 3, maxBytes: 10_000 });
    capture.pushText("a\nb\nc\nd\ne\n");
    expect(capture.getLines()).toEqual(["c", "d", "e"]);
    expect(capture.getTail()).toBe("c\nd\ne");
  });

  it("bounds by maxBytes, dropping oldest lines", () => {
    const capture = makeProcessStderrCapture({ maxLines: 100, maxBytes: 20 });
    // Each of these is 10 bytes; separators add 1 byte each in the tail join.
    capture.pushText("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");
    const tail = capture.getTail();
    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(20);
    expect(capture.getLines().at(-1)).toBe("cccccccccc");
    expect(capture.getLines()).not.toContain("aaaaaaaaaa");
  });

  it("decodes multi-byte UTF-8 across chunk boundaries", () => {
    const capture = makeProcessStderrCapture();
    // "€" is e2 82 ac in UTF-8
    const euro = encoder.encode("price: €\n");
    expect(capture.pushChunk(euro.subarray(0, 8))).toEqual([]);
    expect(capture.pushChunk(euro.subarray(8))).toEqual(["price: €"]);
    expect(capture.getTail()).toBe("price: €");
  });

  it("uses the default budgets", () => {
    expect(DEFAULT_PROCESS_STDERR_MAX_LINES).toBe(200);
    expect(DEFAULT_PROCESS_STDERR_MAX_BYTES).toBe(64 * 1024);
  });

  it("caps an incomplete remainder without newlines", () => {
    const capture = makeProcessStderrCapture({ maxRemainderChars: 8 });
    expect(capture.pushText("abcdefghijklmnop")).toEqual([]);
    expect(capture.getTail()).toBe("ijklmnop");
    expect(capture.didTruncateRemainder()).toBe(true);
    expect(capture.takeRemainderTruncated()).toBe(true);
    expect(capture.takeRemainderTruncated()).toBe(false);
  });

  it("keeps the exposed tail within the byte budget with a partial line", () => {
    const capture = makeProcessStderrCapture({ maxBytes: 16, maxRemainderChars: 100 });
    capture.pushText("old-line\n0123456789abcdefghijklmnop");
    const tail = capture.getTail();
    expect(encoder.encode(tail).byteLength).toBeLessThanOrEqual(16);
    expect(tail).toBe("abcdefghijklmnop");
  });
});

describe("drainProcessStderrCapture", () => {
  effectIt.effect("captures stream bytes and invokes onLine", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const capture = yield* drainProcessStderrCapture(
        Stream.make(encoder.encode("one\ntwo\n"), encoder.encode("three\n")),
        {
          logLabel: "test stderr",
          annotations: { provider: "test" },
          onLine: (line) =>
            Effect.sync(() => {
              seen.push(line);
            }),
        },
      );

      assert.deepEqual(seen, ["one", "two", "three"]);
      assert.equal(capture.getTail(), "one\ntwo\nthree");
    }),
  );

  effectIt.effect("flushes a trailing partial line when the stream ends", () =>
    Effect.gen(function* () {
      const capture = yield* drainProcessStderrCapture(Stream.make(encoder.encode("no-newline")));
      assert.equal(capture.getTail(), "no-newline");
    }),
  );
});
