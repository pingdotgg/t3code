import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { fileChangeRanges } from "./changeIndicators";

describe("change indicators", () => {
  it.each([
    ["one\ntwo\nthree\n", "one\nnew\nthree\n", [{ kind: "addition", start: 2, end: 2 }]],
    ["one\ntwo\n", "two\n", [{ kind: "deletion", start: 0, end: 0 }]],
    ["one\ntwo\n", "one\n", [{ kind: "deletion", start: 1, end: 1 }]],
    ["", "new\n", [{ kind: "addition", start: 1, end: 1 }]],
    ["same\n", "same\n", []],
    ["const retries = 3;\n", "const retries = 4;\n", [{ kind: "addition", start: 1, end: 1 }]],
    ["one\ntwo\nthree\n", "one\nthree\n", [{ kind: "deletion", start: 1, end: 1 }]],
    ["one\n", "", [{ kind: "deletion", start: 0, end: 0 }]],
  ] as const)("maps changes to current file lines (%s → %s)", (before, after, expected) => {
    const diff = parseDiffFromFile(
      { name: "file.ts", contents: before },
      { name: "file.ts", contents: after },
    );
    expect(fileChangeRanges(diff)).toEqual(expected);
  });
});
