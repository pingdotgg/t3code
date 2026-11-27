import { describe, expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

describe("parseGrepOutput ripgrep headings", () => {
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
  ])("keeps matches with their file when $name", ({ output, results }) => {
    expect(parseGrepOutput(output, ".")).toEqual(results);
  });
});
