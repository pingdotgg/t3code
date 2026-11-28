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
});
