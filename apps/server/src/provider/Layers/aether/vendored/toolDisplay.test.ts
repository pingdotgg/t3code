import { describe, expect, it } from "vite-plus/test";

import { fileChangeDiff, parseFileChanges } from "./toolDisplay.ts";

const CODEX_UNIFIED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  " export default a;",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1 @@",
  "+export const b = true;",
].join("\n");

describe("parseFileChanges", () => {
  it("merges the codex files[] input stubs with the buffered result diff", () => {
    // Codex persists `input.files` entries with only `{ path, op }` while the
    // RESULT carries the buffered unified diff in `{ files, output }`.
    const input = {
      files: [
        { path: "src/a.ts", op: "modify" },
        { path: "src/b.ts", op: "create" },
      ],
    };
    const result = JSON.stringify({
      files: [
        { path: "src/a.ts", op: "modify" },
        { path: "src/b.ts", op: "create" },
      ],
      output: CODEX_UNIFIED_DIFF,
    });

    const changes = parseFileChanges(input, result);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.path).toBe("src/a.ts");
    expect(changes[0]?.diff).toContain("-const a = 1;");
    expect(changes[0]?.diff).toContain("+const a = 2;");
    expect(changes[1]?.path).toBe("src/b.ts");
    expect(changes[1]?.diff).toContain("+export const b = true;");
  });

  it("parses the claude single-edit old_string/new_string shape", () => {
    const changes = parseFileChanges(
      {
        file_path: "src/index.ts",
        old_string: "const value = 1;",
        new_string: "const value = 2;",
      },
      undefined,
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      path: "src/index.ts",
      oldText: "const value = 1;",
      newText: "const value = 2;",
      diff: null,
    });
  });

  it("splits a multi-file unified diff result into one change per file", () => {
    const changes = parseFileChanges({}, JSON.stringify({ output: CODEX_UNIFIED_DIFF }));

    expect(changes.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(changes[0]?.diff?.startsWith("diff --git a/src/a.ts b/src/a.ts")).toBe(true);
    expect(changes[1]?.diff?.startsWith("diff --git a/src/b.ts b/src/b.ts")).toBe(true);
  });

  it("treats a claude Write content body as new-file content", () => {
    const changes = parseFileChanges(
      { file_path: "notes.md", content: "hello\nworld\n" },
      undefined,
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.newText).toBe("hello\nworld\n");
    expect(changes[0]?.oldText).toBeNull();
  });

  it("returns an empty list when neither input nor result carries a change shape", () => {
    expect(parseFileChanges({}, undefined)).toEqual([]);
    expect(parseFileChanges({}, "not json")).toEqual([]);
  });
});

describe("fileChangeDiff", () => {
  it("derives an LCS diff from an old/new text pair", () => {
    const summary = fileChangeDiff({
      path: "src/index.ts",
      oldText: "const value = 1;\nexport default value;",
      newText: "const value = 2;\nexport default value;",
      diff: null,
    });

    expect(summary).not.toBeNull();
    expect(summary?.added).toBe(1);
    expect(summary?.removed).toBe(1);
    expect(
      summary?.lines.some((line) => line.kind === "add" && line.text === "const value = 2;"),
    ).toBe(true);
  });

  it("parses a unified diff body with line numbers", () => {
    const summary = fileChangeDiff({
      path: "src/a.ts",
      oldText: null,
      newText: null,
      diff: ["@@ -1,2 +1,2 @@", "-const a = 1;", "+const a = 2;", " export default a;"].join("\n"),
    });

    expect(summary).not.toBeNull();
    expect(summary?.added).toBe(1);
    expect(summary?.removed).toBe(1);
    expect(summary?.lines[0]).toEqual({
      kind: "del",
      text: "const a = 1;",
      oldLine: 1,
      newLine: null,
    });
  });

  it("returns null for a path-only stub", () => {
    expect(
      fileChangeDiff({ path: "src/a.ts", oldText: null, newText: null, diff: null }),
    ).toBeNull();
  });
});
