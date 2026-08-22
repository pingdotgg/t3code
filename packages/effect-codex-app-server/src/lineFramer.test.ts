import { assert, it } from "@effect/vitest";

import { makeLineFramer } from "./lineFramer.ts";

const collectLines = (chunks: ReadonlyArray<string>) => {
  const framer = makeLineFramer();
  const lines = chunks.flatMap((chunk) => framer.push(chunk));
  const finalLine = framer.finish();
  return finalLine === undefined ? lines : [...lines, finalLine];
};

it("preserves LF, CRLF, empty-line, and unterminated-line semantics across chunks", () => {
  assert.deepEqual(collectLines(["alpha\r", "\n", "\nb", "eta\n", "gamma", "\r", "\ndelta"]), [
    "alpha",
    "",
    "beta",
    "gamma",
    "delta",
  ]);
});

it("handles chunk boundaries immediately before, after, and within line endings", () => {
  assert.deepEqual(collectLines(["one", "\n", "two\n", "\r", "\n", "three\r", "\nfour"]), [
    "one",
    "two",
    "",
    "three",
    "four",
  ]);
});

it("retains a large fragmented line without emitting partial records", () => {
  const framer = makeLineFramer();
  const recordSize = 20 * 1024 * 1024;
  const record = "0123456789abcdef".repeat(recordSize / 16);
  const chunkSizes = [4_093, 8_191, 16_381];
  let offset = 0;
  let chunkIndex = 0;
  const startedAt = performance.now();

  while (offset < record.length) {
    const nextOffset = Math.min(
      record.length,
      offset + chunkSizes[chunkIndex % chunkSizes.length]!,
    );
    assert.deepEqual(framer.push(record.slice(offset, nextOffset)), []);
    offset = nextOffset;
    chunkIndex++;
  }

  const completed = framer.push("\n");
  assert.lengthOf(completed, 1);
  assert.equal(completed[0], record);
  assert.isUndefined(framer.finish());
  assert.isBelow(performance.now() - startedAt, 2_000);
});
