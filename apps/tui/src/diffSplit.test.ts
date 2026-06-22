import { describe, expect, it } from "bun:test";

import { filetypeForPath, splitUnifiedDiff } from "./diffSplit.ts";

describe("filetypeForPath", () => {
  it("maps known extensions to OpenTUI grammars", () => {
    expect(filetypeForPath("src/app.ts")).toBe("typescript");
    expect(filetypeForPath("a/Component.tsx")).toBe("typescript");
    expect(filetypeForPath("lib/util.js")).toBe("javascript");
    expect(filetypeForPath("README.md")).toBe("markdown");
    expect(filetypeForPath("build.zig")).toBe("zig");
  });

  it("returns undefined for unknown or extensionless paths", () => {
    expect(filetypeForPath("data.toml")).toBeUndefined();
    expect(filetypeForPath("Makefile")).toBeUndefined();
    expect(filetypeForPath(".gitignore")).toBeUndefined();
  });
});

describe("splitUnifiedDiff", () => {
  it("splits a multi-file git diff into per-file sections with filetypes", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/docs/readme.md b/docs/readme.md",
      "index 333..444 100644",
      "--- a/docs/readme.md",
      "+++ b/docs/readme.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const files = splitUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(files.map((f) => f.filetype)).toEqual(["typescript", "markdown"]);
    // Each section keeps its own hunk and nothing leaks across files.
    expect(files[0]?.body).toContain("+const a = 2;");
    expect(files[0]?.body).not.toContain("readme");
    expect(files[1]?.body).toContain("+new");
  });

  it("uses the old path for a pure deletion (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-was here",
    ].join("\n");
    expect(splitUnifiedDiff(diff)[0]?.path).toBe("src/gone.ts");
  });

  it("treats a diff with no `diff --git` header as a single section", () => {
    const diff = ["--- a/x.js", "+++ b/x.js", "@@ -1 +1 @@", "-1", "+2"].join("\n");
    const files = splitUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("x.js");
    expect(files[0]?.filetype).toBe("javascript");
  });

  it("returns an empty array for blank input", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("   \n  ")).toEqual([]);
  });
});
