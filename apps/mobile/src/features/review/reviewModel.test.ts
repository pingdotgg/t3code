import { describe, expect, it } from "vite-plus/test";

import { applyReviewDiffMetadata, buildReviewParsedDiff } from "./reviewModel";

describe("buildReviewParsedDiff", () => {
  it("keeps UI identities compact, stable, and isolated from parser cache keys", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const scope = JSON.stringify({ target: 'remote\\"scope'.repeat(100) });
    const parsed = buildReviewParsedDiff(patch + patch, scope);
    const repeated = buildReviewParsedDiff(patch + patch, scope);
    const otherSection = buildReviewParsedDiff(patch + patch, `${scope}:other`);
    const changed = buildReviewParsedDiff((patch + patch).replaceAll("after", "changed"), scope);
    if (
      parsed.kind !== "files" ||
      repeated.kind !== "files" ||
      otherSection.kind !== "files" ||
      changed.kind !== "files"
    )
      throw new Error("Expected structured diffs");

    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.map((file) => file.id)).toEqual(repeated.files.map((file) => file.id));
    expect(parsed.files.map((file) => file.cacheKey)).toEqual(
      repeated.files.map((file) => file.cacheKey),
    );
    const ids = parsed.files.flatMap((file) => [file.id, ...file.rows.map((row) => row.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThan(48);
    for (const variant of [otherSection, changed]) {
      const otherIds = variant.files.flatMap((file) => [
        file.id,
        ...file.rows.map((row) => row.id),
      ]);
      expect(otherIds.some((id) => ids.includes(id))).toBe(false);
    }
    expect(parsed.files[0]!.cacheKey.length).toBeGreaterThan(scope.length);
    expect(parsed.files[0]!.id).not.toBe(parsed.files[0]!.cacheKey);
    expect(repeated.files[0]!.rows.map((row) => row.id)).toEqual(
      parsed.files[0]!.rows.map((row) => row.id),
    );
  });

  it.each(["", "\n\n[truncated]"])(
    "preserves the final blank context in the resourceTelemetry excerpt with suffix %j",
    (suffix) => {
      const parsed = buildReviewParsedDiff(
        [
          "diff --git a/packages/contracts/src/resourceTelemetry.ts b/packages/contracts/src/resourceTelemetry.ts",
          "--- a/packages/contracts/src/resourceTelemetry.ts",
          "+++ b/packages/contracts/src/resourceTelemetry.ts",
          "@@ -350,6 +371,7 @@",
          "   DesktopTelemetryRequestDesktopUpdate,",
          "   DesktopTelemetryCommitDesktopUpdate,",
          "   DesktopTelemetryCancelDesktopUpdate,",
          "+  DesktopUpdateRestartPolicyResult,",
          " ]);",
          " export type DesktopTelemetryControlMessage = typeof DesktopTelemetryControlMessage.Type;",
          " ",
          "",
        ].join("\n") + suffix,
        "resource-telemetry",
      );
      expect(parsed.kind).toBe("files");
      if (parsed.kind !== "files") return;
      expect(parsed.files[0]?.rows.at(-1)).toMatchObject({
        kind: "line",
        change: "context",
        oldLineNumber: 355,
        newLineNumber: 377,
        content: "",
      });
      expect(parsed.files[0]?.additionLines.at(-1)).toBe("\n");
      expect(parsed.files[0]?.deletionLines.at(-1)).toBe("\n");
    },
  );

  it("preserves final content whitespace and gives distinct patches distinct cache keys", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+value \t\n";
    const parsed = buildReviewParsedDiff(patch, "whitespace");
    const withoutWhitespace = buildReviewParsedDiff(
      patch.replace("value \t", "value"),
      "whitespace",
    );
    expect(parsed.kind).toBe("files");
    expect(withoutWhitespace.kind).toBe("files");
    if (parsed.kind !== "files" || withoutWhitespace.kind !== "files") return;
    expect(parsed.files[0]?.rows.at(-1)).toMatchObject({ content: "value \t" });
    expect(parsed.files[0]?.additionLines).toEqual(["value \t\n"]);
    expect(parsed.files[0]?.cacheKey).not.toBe(withoutWhitespace.files[0]?.cacheKey);
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("preserves missing-newline flags for old=%s and new=%s", (oldMissing, newMissing) => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-value",
        ...(oldMissing ? ["\\ No newline at end of file"] : []),
        "+value",
        ...(newMissing ? ["\\ No newline at end of file"] : []),
        "",
      ].join("\n"),
      "eof",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]).toMatchObject({
      noEOFCRDeletions: oldMissing,
      noEOFCRAdditions: newMissing,
      deletionLines: [oldMissing ? "value" : "value\n"],
      additionLines: [newMissing ? "value" : "value\n"],
    });
  });

  it.each([
    ["a/example.ts", "a/example.ts"],
    ["a/before.ts", "b/after.ts"],
  ])("preserves repository paths from %s to %s", (previousPath, path) => {
    const parsed = buildReviewParsedDiff(
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
      "repository-paths",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]).toMatchObject({
      path,
      previousPath: previousPath === path ? null : previousPath,
      additions: 1,
      deletions: 1,
    });
  });

  it("builds renderable rows from a unified patch", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1,2 +1,3 @@",
        "-const before = 1;",
        "+const after = 2;",
        "+console.log(after);",
        " return true;",
      ].join("\n"),
      "unit",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.fileCount).toBe(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      path: "apps/mobile/src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: "hunk", header: "@@ -1,2 +1,3 @@" }),
      expect.objectContaining({
        kind: "line",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        comparison: { change: "add", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        comparison: { change: "delete", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
        content: "console.log(after);",
        comparison: null,
      }),
      expect.objectContaining({
        kind: "line",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 3,
        content: "return true;",
        comparison: null,
      }),
    ]);
  });

  it("treats truncated patches as partial diffs instead of failing", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1 +1,2 @@",
        " const before = 1;",
        "+const after = 2;",
        "",
        "[truncated]",
      ].join("\n"),
      "unit-truncated",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.notice).toContain("server size cap");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.files[0]?.rows[0]).toMatchObject({
      kind: "hunk",
      header: "@@ -1,1 +1,2 @@",
    });
  });
});

describe("applyReviewDiffMetadata", () => {
  it("uses complete counts even when the preview contains only part of one file", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/large.txt b/large.txt",
        "--- a/large.txt",
        "+++ b/large.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      "partial",
    );
    const result = applyReviewDiffMetadata(parsed, {
      truncated: true,
      files: [
        { path: "large.txt", previousPath: null, additions: 4000, deletions: 3000 },
        { path: "unseen.txt", previousPath: null, additions: 100, deletions: 20 },
      ],
    });
    expect(result.kind).toBe("files");
    if (result.kind !== "files") return;
    expect(result.fileCount).toBe(2);
    expect(result.additions).toBe(4100);
    expect(result.deletions).toBe(3020);
    expect(result.files[0]?.additions).toBe(4000);
    expect(result.notice).toContain("Counts include all changes");
    expect(applyReviewDiffMetadata(parsed, null)).toEqual(parsed);
  });
});
