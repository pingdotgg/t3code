import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import { resolveDiffReviewPosition } from "../reviewCommentContext";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("hides indentation changes around inserted JSX without moving review lines", () => {
    const patch = [
      "diff --git a/item.tsx b/item.tsx",
      "--- a/item.tsx",
      "+++ b/item.tsx",
      "@@ -40,5 +40,7 @@",
      ' <ItemContent className="min-w-0">',
      "-  <ItemTitle>",
      '-    <h4 className="wrap-break-word">{name}</h4>',
      "-  </ItemTitle>",
      "+  {showName && (",
      "+    <ItemTitle>",
      '+      <h4 className="wrap-break-word">{name}</h4>',
      "+    </ItemTitle>",
      "+  )}",
      " </ItemContent>",
      "@@ -80 +82 @@",
      "-const value = 1;",
      "+const value = 2;",
    ].join("\n");
    const shown = getRenderablePatch(patch, "pr", { compactPartialHunkOffsets: true });
    const hidden = getRenderablePatch(patch, "pr", {
      compactPartialHunkOffsets: true,
      ignoreWhitespace: true,
    });
    expect(shown?.kind).toBe("files");
    expect(hidden?.kind).toBe("files");
    if (shown?.kind !== "files" || hidden?.kind !== "files") return;
    expect(getDiffLineStat(shown.files)).toEqual({ additions: 6, deletions: 4 });
    expect(getDiffLineStat(hidden.files)).toEqual({ additions: 3, deletions: 1 });
    const file = hidden.files[0]!;
    expect(file.additionLines).toEqual(shown.files[0]!.additionLines);
    expect(file.deletionLines).toEqual(shown.files[0]!.deletionLines);
    expect(file.cacheKey).not.toBe(shown.files[0]!.cacheKey);
    expect(resolveDiffReviewPosition(hidden.sourceFiles[0]!, 43, "additions")).toEqual({
      kind: "added",
      newLine: 43,
    });
    expect(resolveDiffReviewPosition(hidden.sourceFiles[0]!, 42, "deletions")).toEqual({
      kind: "deleted",
      oldLine: 42,
    });
    expect(file.hunks[0]?.hunkContent).toContainEqual({
      type: "context",
      lines: 3,
      additionLineIndex: 2,
      deletionLineIndex: 1,
    });
    expect(resolveDiffReviewPosition(file, 41, "additions")).toEqual({
      kind: "added",
      newLine: 41,
    });
    expect(resolveDiffReviewPosition(file, 43, "additions")).toEqual({
      kind: "context",
      oldLine: 42,
      newLine: 43,
      side: "right",
    });
    expect(resolveDiffReviewPosition(file, 42, "deletions")).toEqual({
      kind: "context",
      oldLine: 42,
      newLine: 43,
      side: "left",
    });
    expect(file.hunks[1]).toMatchObject({
      additionStart: 82,
      deletionStart: 80,
      splitLineStart: 7,
      unifiedLineStart: 7,
    });
    const prefix = "unchanged\n".repeat(39);
    const gap = "unchanged\n".repeat(35);
    const hydrated = hydratePartialDiff("clone", file, {
      oldFile: {
        name: file.name,
        contents: prefix + file.deletionLines.slice(0, 5).join("") + gap + "const value = 1;\n",
      },
      newFile: {
        name: file.name,
        contents: prefix + file.additionLines.slice(0, 7).join("") + gap + "const value = 2;\n",
      },
    });
    expect(getDiffLineStat([hydrated])).toEqual({ additions: 3, deletions: 1 });
    expect(resolveDiffReviewPosition(hydrated, 43, "additions")).toEqual(
      resolveDiffReviewPosition(file, 43, "additions"),
    );
  });

  it.each([
    ["  const x = 1;\t", "\tconst x=1;", 0, 0],
    ["const x = 1;", "const x = 2;", 1, 1],
    ["const x = 1;", "const x = 1;\n", 1, 0],
  ])("filters whitespace in %j to %j", (before, after, additions, deletions) => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      `@@ -1 +1,${after.split("\n").length} @@`,
      `-${before}`,
      ...after.split("\n").map((line) => `+${line}`),
      "",
    ].join("\n");
    const filtered = getRenderablePatch(patch, "pr", { ignoreWhitespace: true });
    expect(filtered?.kind).toBe("files");
    if (filtered?.kind !== "files") return;
    expect(getDiffLineStat(filtered.files)).toEqual({ additions, deletions });
  });

  it.each(["+", "-"])("keeps %s blank lines without a final newline", (sign) => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/blank.txt b/blank.txt",
        "--- a/blank.txt",
        "+++ b/blank.txt",
        sign === "+" ? "@@ -0,0 +1 @@" : "@@ -1 +0,0 @@",
        `${sign}  `,
        "\\ No newline at end of file",
      ].join("\n"),
      "pr",
      { ignoreWhitespace: true },
    );
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(getDiffLineStat(parsed.files)).toEqual({
      additions: sign === "+" ? 1 : 0,
      deletions: sign === "-" ? 1 : 0,
    });
  });

  it.each([
    ["a/example.ts", "a/example.ts", "change"],
    ["b/example.ts", "b/example.ts", "change"],
    ["a/before.ts", "b/after.ts", "rename-changed"],
  ])("preserves repository paths from %s to %s", (previousPath, path, type) => {
    const parsed = getRenderablePatch(
      [
        `diff --git a/${previousPath} b/${path}`,
        ...(previousPath === path
          ? []
          : ["similarity index 50%", `rename from ${previousPath}`, `rename to ${path}`]),
        `--- a/${previousPath}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
    );
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    expect(resolveFileDiffPath(file)).toBe(path);
    expect(resolveFileDiffPreviousPath(file)).toBe(previousPath);
    expect(buildFileDiffIdentityKey(file)).toBe(`${previousPath}\0${path}\0${type}`);
  });

  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("diff file reconciliation", () => {
  it("keeps Pierre's render key stable when a partial diff hydrates", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "hydrated-key");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffRenderKey(file);
    file.cacheKey = `${file.cacheKey}:hydrated`;

    expect(buildFileDiffRenderKey(file)).toBe(key);
  });

  it("gives a type change its own identity per block", () => {
    const patch = [
      "diff --git a/AGENTS.md b/AGENTS.md",
      "deleted file mode 100644",
      "--- a/AGENTS.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-duplicated instructions",
      "diff --git a/AGENTS.md b/AGENTS.md",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/AGENTS.md",
      "@@ -0,0 +1 @@",
      "+CLAUDE.md",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "type-change");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    const [deleted, added] = parsed.files;
    expect(deleted?.type).toBe("deleted");
    expect(added?.type).toBe("new");
    if (!deleted || !added) return;

    expect(buildFileDiffIdentityKey(deleted)).not.toBe(buildFileDiffIdentityKey(added));
    expect(new Set(parsed.files.map(buildFileDiffIdentityKey)).size).toBe(parsed.files.length);
  });

  it("keeps identities stable and versions local to the changed file", () => {
    const patch = (secondLine: string) =>
      [
        "diff --git a/unchanged.ts b/unchanged.ts",
        "--- a/unchanged.ts",
        "+++ b/unchanged.ts",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "diff --git a/changed.ts b/changed.ts",
        "--- a/changed.ts",
        "+++ b/changed.ts",
        "@@ -1 +1 @@",
        "-old",
        `+${secondLine}`,
      ].join("\n");
    const before = getRenderablePatch(patch("new"), "before");
    const after = getRenderablePatch(patch("newer"), "after");
    expect(before?.kind).toBe("files");
    expect(after?.kind).toBe("files");
    if (before?.kind !== "files" || after?.kind !== "files") return;

    const [beforeUnchanged, beforeChanged] = before.files;
    const [afterUnchanged, afterChanged] = after.files;
    expect(beforeUnchanged).toBeDefined();
    expect(beforeChanged).toBeDefined();
    expect(afterUnchanged).toBeDefined();
    expect(afterChanged).toBeDefined();
    if (!beforeUnchanged || !beforeChanged || !afterUnchanged || !afterChanged) return;

    expect(buildFileDiffIdentityKey(afterUnchanged)).toBe(
      buildFileDiffIdentityKey(beforeUnchanged),
    );
    expect(buildFileDiffIdentityKey(afterChanged)).toBe(buildFileDiffIdentityKey(beforeChanged));
    expect(buildFileDiffContentVersion(afterUnchanged)).toBe(
      buildFileDiffContentVersion(beforeUnchanged),
    );
    expect(buildFileDiffContentVersion(afterChanged)).not.toBe(
      buildFileDiffContentVersion(beforeChanged),
    );
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});

describe("a file whose name a patch header cannot carry plainly", () => {
  /** How git writes such a name, and so how every provider's patch arrives here. */
  const quotedPatch = (written: string) =>
    [
      `diff --git "a/${written}" "b/${written}"`,
      "index 1111111..2222222 100644",
      `--- "a/${written}"`,
      `+++ "b/${written}"`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

  const pathOf = (patch: string) => {
    const parsed = getRenderablePatch(patch, "review");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") throw new Error("patch did not parse as files");
    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) throw new Error("patch carried no file");
    return resolveFileDiffPath(file);
  };

  it("is the name the host knows, not the part of it before the tab", () => {
    // The path is what a viewed mark, a review comment and a file read are all asked for by, so a
    // name read short is a mark put on a path the host has never heard of.
    expect(pathOf(quotedPatch("tab\\tfile.txt"))).toBe("tab\tfile.txt");
  });

  it("is the name the host knows, not the part of it before the newline", () => {
    expect(pathOf(quotedPatch("line\\nfile.txt"))).toBe("line\nfile.txt");
  });

  it("reads the octal a host with core.quotePath on writes for a name outside ASCII", () => {
    expect(pathOf(quotedPatch("caf\\303\\251/r\\303\\251sum\\303\\251.ts"))).toBe("café/résumé.ts");
  });

  it("reads both sides of a rename under the names they really have", () => {
    const patch = [
      'diff --git "a/old\\tname.ts" "b/new\\tname.ts"',
      "similarity index 90%",
      'rename from "old\\tname.ts"',
      'rename to "new\\tname.ts"',
      "",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;

    expect(resolveFileDiffPath(file)).toBe("new\tname.ts");
    expect(resolveFileDiffPreviousPath(file)).toBe("old\tname.ts");
  });
});
