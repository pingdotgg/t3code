import { describe, expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

describe("parseGrepOutput ripgrep formats", () => {
  it.each([
    {
      name: "the first match contains a timestamp",
      output: "docs/notes:12:draft.md\n2:at 10:30:00 needle",
      results: [{ fileName: "docs/notes:12:draft.md", line: 2, preview: "at 10:30:00 needle" }],
    },
    {
      name: "the next filename starts with digits and a colon",
      output: "README.md\n1:needle first\n\n2026:12:draft.md\n2:needle second",
      results: [
        { fileName: "README.md", line: 1, preview: "needle first" },
        { fileName: "2026:12:draft.md", line: 2, preview: "needle second" },
      ],
    },
    {
      name: "a grouped filename is parenthesized",
      output: "(notes:12:draft.md)\n2:needle",
      results: [{ fileName: "(notes:12:draft.md)", line: 2, preview: "needle" }],
    },
    {
      name: "the second inline filename is all digits",
      output: "a.ts:1:first\n2026:3:second",
      results: [
        { fileName: "a.ts", line: 1, preview: "first" },
        { fileName: "2026", line: 3, preview: "second" },
      ],
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
});
