import { describe, expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

describe("parseGrepOutput ripgrep formats", () => {
  it.each([
    {
      name: "the next filename starts with digits and a colon",
      output: "README.md\n1:needle first\n\n2026:12:draft.md\n2:at 10:30:00 needle",
      results: [
        { fileName: "README.md", line: 1, preview: "needle first" },
        { fileName: "2026:12:draft.md", line: 2, preview: "at 10:30:00 needle" },
      ],
    },
    {
      name: "a grouped filename is parenthesized",
      output: "(notes:12:draft.md)\n2:needle",
      results: [{ fileName: "(notes:12:draft.md)", line: 2, preview: "needle" }],
    },
    {
      name: "a later inline filename starts with digits and a colon",
      output: "a.ts:1:first\na.ts:2:second\n2026:notes.md:3:third",
      results: [
        { fileName: "a.ts", line: 1, preview: "first" },
        { fileName: "a.ts", line: 2, preview: "second" },
        { fileName: "2026:notes.md", line: 3, preview: "third" },
      ],
    },
  ])("keeps matches with their file when $name", ({ output, results }) => {
    expect(parseGrepOutput(output, ".")).toEqual(results);
  });

  it.each([
    ["grouped text starts with digits and a colon", "docs/notes:12:draft.md\n2:10:needle"],
    ["grouped text contains a timestamp", "docs/notes:12:draft.md\n2:at 10:30:00 needle"],
    ["the second inline filename is all digits", "a.ts:1:first\n2026:3:second"],
    ["the second inline filename has a numeric prefix", "a.ts:1:first\n2026:notes.md:3:second"],
  ])("keeps ambiguous output raw when %s", (_name, output) => {
    expect(parseGrepOutput(output, ".")).toBeUndefined();
  });
});
