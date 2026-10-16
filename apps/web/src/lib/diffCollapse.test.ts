import { describe, expect, it } from "vite-plus/test";

import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "./diffCollapse";
import { buildLazyFileDiffIdentityKey, getRenderablePatch } from "./diffRendering";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set(FILE_KEYS));
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set(FILE_KEYS))).toEqual(new Set());
  });

  it.each([
    ["change", ["--- a/later.ts", "+++ b/later.ts", "@@ -1 +1 @@", "-before", "+after"]],
    ["new", ["new file mode 100644", "--- /dev/null", "+++ b/later.ts", "@@ -0,0 +1 @@", "+after"]],
    [
      "deleted",
      ["deleted file mode 100644", "--- a/later.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-before"],
    ],
    ["rename-pure", ["similarity index 100%", "rename from before.ts", "rename to later.ts"]],
    [
      "rename-changed",
      [
        "similarity index 50%",
        "rename from before.ts",
        "rename to later.ts",
        "--- a/before.ts",
        "+++ b/later.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ],
    ],
  ])("preserves bulk and individual collapse choices when a lazy %s file loads", (type, lines) => {
    const parsed = getRenderablePatch(["diff --git a/later.ts b/later.ts", ...lines].join("\n"));
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") throw new Error("Expected a parsed diff");
    const loaded = parsed.files[0]!;
    expect(loaded.type).toBe(type);
    const pendingKey = buildLazyFileDiffIdentityKey({
      ...loaded,
      type: loaded.prevName ? "rename-changed" : "change",
    });
    const loadedKey = buildLazyFileDiffIdentityKey(loaded);
    const collapsed = toggleAllDiffFiles([FIRST_FILE_KEY, pendingKey], new Set());
    expect(collapsed.has(loadedKey)).toBe(true);
    expect(areAllDiffFilesCollapsed([FIRST_FILE_KEY, loadedKey], collapsed)).toBe(true);
    expect(toggleAllDiffFiles([FIRST_FILE_KEY, loadedKey], collapsed)).toEqual(new Set());

    // A file-tree reveal can expand a placeholder before its patch arrives.
    const expanded = new Set(collapsed);
    expanded.delete(pendingKey);
    expect(expanded.has(loadedKey)).toBe(false);
    expect(expanded.has(FIRST_FILE_KEY)).toBe(true);
  });
});
