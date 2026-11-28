import { describe, expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

describe("grouped ripgrep line numbers", () => {
  it.each([
    ["/repo/docs/a:0:b.txt", ["start:8:needle"]],
    ["/repo/docs/a:12:b.txt", ["start:0:needle"]],
    ["/repo/docs/a:12:b.txt", ["start:8:needle", "start:00:needle"]],
  ])("keeps matches for %s with previews %j", (fileName, previews) => {
    const output = [fileName, ...previews.map((preview, index) => `${index + 7}:${preview}`)].join(
      "\n",
    );
    expect(parseGrepOutput(output, "/repo")).toEqual(
      previews.map((preview, index) => ({ fileName, line: index + 7, preview })),
    );
  });

  it.each([
    ["the second filename", "a.ts:1:first\n2026:0:notes.md:3:second"],
    ["the first filename", "a:0:b.txt:1:first\n2026:3:second"],
    ["a later filename", "a.ts:1:first\n2026:3:second\n2026:0:notes.md:004:third"],
  ])("leaves ambiguous output with a zero in %s raw", (_name, output) => {
    expect(parseGrepOutput(output, "/repo")).toBeUndefined();
  });
});
