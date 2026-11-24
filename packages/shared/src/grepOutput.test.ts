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
  });

  it("reads ripgrep's inline and heading forms", () => {
    expect(parseGrepOutput("src/a.ts:4:const a = 1;\nC:\\w\\b.ts:9:b: 2", ".")).toEqual([
      { fileName: "src/a.ts", line: 4, preview: "const a = 1;" },
      { fileName: "C:\\w\\b.ts", line: 9, preview: "b: 2" },
    ]);
    expect(parseGrepOutput("src/a.ts\n4:  const a = 1;\n7:a();", ".")).toEqual([
      { fileName: "src/a.ts", line: 4, preview: "  const a = 1;" },
      { fileName: "src/a.ts", line: 7, preview: "a();" },
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
    ["a file list", "/repo/a.ts\n/repo/b.ts"],
    ["no matches", "No files found"],
    ["ripgrep context lines", "a.ts\n1-before\n2:needle"],
    ["a line zero", "a.ts:0:needle"],
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
