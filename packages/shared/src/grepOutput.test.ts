import { describe, expect, it } from "vite-plus/test";

import { parseGrepOutput } from "./grepOutput.ts";

describe("parseGrepOutput", () => {
  it("reads OpenCode's grep output", () => {
    const output = [
      "Found 3 matches",
      "/repo/src/one.ts:",
      '  Line 1: export const heading = "intro";',
      "",
      '  Line 3: export const footer = "outro";',
      "",
      "",
      "/repo/src/two.ts:",
      "  Line 1: export const second = 2;",
      "",
      "(Results are truncated. Consider using a more specific path or pattern.)",
    ].join("\n");
    expect(parseGrepOutput(output, "/repo/src")).toEqual([
      { fileName: "/repo/src/one.ts", line: 1, preview: 'export const heading = "intro";' },
      { fileName: "/repo/src/one.ts", line: 3, preview: 'export const footer = "outro";' },
      { fileName: "/repo/src/two.ts", line: 1, preview: "export const second = 2;" },
      {
        fileName: "/repo/src",
        preview: "(Results are truncated. Consider using a more specific path or pattern.)",
      },
    ]);
    expect(
      parseGrepOutput("Found 1 matches\n/tmp/a:12:b.txt:\n  Line 2: needle second\n", "/tmp"),
    ).toEqual([{ fileName: "/tmp/a:12:b.txt", line: 2, preview: "needle second" }]);
  });

  it("reads ripgrep's inline and heading forms", () => {
    expect(parseGrepOutput("src/a.ts:4:const a = 1;\nC:\\w\\b.ts:9:b: 2", ".")).toEqual([
      { fileName: "src/a.ts", line: 4, preview: "const a = 1;" },
      { fileName: "C:\\w\\b.ts", line: 9, preview: "b: 2" },
    ]);
    expect(parseGrepOutput("/tmp/a:12:b.txt:", "/tmp")).toEqual([
      { fileName: "/tmp/a", line: 12, preview: "b.txt:" },
    ]);
    expect(parseGrepOutput("a.ts:1:needle:\nLine 2:3:needle", ".")).toEqual([
      { fileName: "a.ts", line: 1, preview: "needle:" },
      { fileName: "Line 2", line: 3, preview: "needle" },
    ]);
    expect(parseGrepOutput("src/a.ts\n4:  const a = 1;\n7:a();", ".")).toEqual([
      { fileName: "src/a.ts", line: 4, preview: "  const a = 1;" },
      { fileName: "src/a.ts", line: 7, preview: "a();" },
    ]);
    expect(
      parseGrepOutput(
        "docs/Release notes.md \n2:match\n\ndocs/Release notes.md\n6:another match",
        ".",
      ),
    ).toEqual([
      { fileName: "docs/Release notes.md ", line: 2, preview: "match" },
      { fileName: "docs/Release notes.md", line: 6, preview: "another match" },
    ]);
    expect(
      parseGrepOutput(
        "README.md\n1:needle first\n\ndocs/Release notes:12:draft.md\n2:needle second\n",
        ".",
      ),
    ).toEqual([
      { fileName: "README.md", line: 1, preview: "needle first" },
      { fileName: "docs/Release notes:12:draft.md", line: 2, preview: "needle second" },
    ]);
    expect(
      parseGrepOutput("README.md\n1:needle first\n\n2026:12:draft.md\n2:at 10:30:00 needle", "."),
    ).toEqual([
      { fileName: "README.md", line: 1, preview: "needle first" },
      { fileName: "2026:12:draft.md", line: 2, preview: "at 10:30:00 needle" },
    ]);
    expect(parseGrepOutput("(notes:12:draft.md)\n2:needle", ".")).toEqual([
      { fileName: "(notes:12:draft.md)", line: 2, preview: "needle" },
    ]);
    expect(parseGrepOutput(" notes.md\n2:needle", ".")).toEqual([
      { fileName: " notes.md", line: 2, preview: "needle" },
    ]);
    expect(parseGrepOutput("a.ts:1:first\na.ts:2:second\n2026:notes.md:3:third", ".")).toEqual([
      { fileName: "a.ts", line: 1, preview: "first" },
      { fileName: "a.ts", line: 2, preview: "second" },
      { fileName: "2026:notes.md", line: 3, preview: "third" },
    ]);
  });

  it("reads Gemini's File and L-numbered form", () => {
    const output = [
      'Found 2 matches for pattern "needle" in path "src":',
      "---",
      "File: one.ts",
      "L2: const needle = 1;",
      "---",
      "File: two.ts",
      "L7: needle();",
      "---",
    ].join("\n");
    expect(parseGrepOutput(output, "src")).toEqual([
      { fileName: "one.ts", line: 2, preview: "const needle = 1;" },
      { fileName: "two.ts", line: 7, preview: "needle();" },
    ]);
  });

  it.each([
    ["a directory listing", "Contents of /repo:\n  [DIR] .git\n  [FILE] README.md"],
    ["an error", "ripgrep failed: invalid regex"],
    ["prose before a tool-specific numbered line", "Text output\n  Line 2: not a grep match"],
    ["a file list", "/repo/a.ts\n/repo/b.ts"],
    ["no matches", "No files found"],
    ["ripgrep context lines", "a.ts\n1-before\n2:needle"],
    ["a line zero", "a.ts:0:needle"],
    ["grouped text starts with digits and a colon", "docs/notes:12:draft.md\n2:10:needle"],
    ["grouped text contains a timestamp", "docs/notes:12:draft.md\n2:at 10:30:00 needle"],
    ["the second inline filename is all digits", "a.ts:1:first\n2026:3:second"],
    ["the second inline filename has a numeric prefix", "a.ts:1:first\n2026:notes.md:3:second"],
    ["two inline rows with a leading-space filename", " notes.md:1:first\n2026:3:second"],
  ])("leaves %s raw", (_name, output) => {
    expect(parseGrepOutput(output, "/repo")).toBeUndefined();
  });

  it("keeps file and line once the matched text exceeds its budget", () => {
    const long = "x".repeat(5_000);
    expect(parseGrepOutput(`a.ts:1:${long}\na.ts:2:${long}\na.ts:3:short`, ".")).toEqual([
      { fileName: "a.ts", line: 1, preview: long },
      { fileName: "a.ts", line: 2 },
      { fileName: "a.ts", line: 3, preview: "short" },
    ]);
  });

  it("counts notes against the budget", () => {
    const results = parseGrepOutput(`a.ts:1:x\n(${"n".repeat(9_000)})`, ".");
    expect(results?.[0]).toEqual({ fileName: "a.ts", line: 1, preview: "x" });
    expect(results?.[1]?.preview?.length).toBe(500);
  });
});
