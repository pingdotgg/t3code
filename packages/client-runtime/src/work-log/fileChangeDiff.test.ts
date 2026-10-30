import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";
import { toolCallDiff } from "./fileChangeDiff.ts";

function renderedFiles(patch: string | undefined) {
  return patch ? parsePatchFiles(patch.trim()).flatMap((parsed) => parsed.files) : [];
}

describe("toolCallDiff", () => {
  it("renders recorded hunks without reading a repository, including renamed paths", () => {
    for (const changes of [
      undefined,
      [{ operation: "update", oldPath: "old.ts", path: "new.ts" }],
    ]) {
      const { patch } = toolCallDiff({
        fileName: "old.ts",
        diffStr: "@@ -1 +1 @@\n-before\n+after\n",
        ...(changes ? { changes } : {}),
      });
      const files = renderedFiles(patch);
      expect(files).toHaveLength(1);
      expect(files[0]!.name).toBe(changes ? "new.ts" : "old.ts");
      expect(files[0]!.additionLines.join("")).toContain("after");
      expect(files[0]!.deletionLines.join("")).toContain("before");
    }
  });

  it("renders added and deleted file contents as a file diff", () => {
    for (const operation of ["add", "delete"]) {
      for (const [content, ending] of [
        ["first\nsecond", ""],
        ["@@ -0,0 +1 @@\n+content", "\n"],
        ["@@ -1 +0,0 @@\n-content", "\n"],
        ["first\nsecond", "\n"],
        ["--- notes\nsecond", "\n"],
        ["diff --git notes\nsecond", "\n"],
        ["--- a/embedded.ts\n+++ b/embedded.ts\n@@ -1 +1 @@\n-before\n+after", "\n"],
        [
          "diff --git a/embedded.ts b/embedded.ts\n--- a/embedded.ts\n+++ b/embedded.ts\n@@ -1 +1 @@\n-before\n+after",
          "\n",
        ],
      ] as const) {
        const recordedContent = `${content}${ending}`;
        const files = renderedFiles(
          toolCallDiff({
            fileName: "file with spaces.ts",
            diffStr: recordedContent,
            changes: [{ operation, path: "file with spaces.ts" }],
          }).patch,
        );
        expect(files.length).toBeGreaterThan(0);
        const file = files[0]!;
        expect(file.name ?? file.prevName).toBe("file with spaces.ts");
        const lines = content.split("\n").length;
        expect(file.additionLines).toHaveLength(operation === "add" ? lines : 0);
        expect(file.deletionLines).toHaveLength(operation === "delete" ? lines : 0);
        expect((operation === "add" ? file.additionLines : file.deletionLines).join("")).toBe(
          recordedContent.replace(/\n$/, ""),
        );
      }
    }
  });

  it("keeps content-only writes out of the patch and preserves empty recorded content", () => {
    for (const operation of ["add", "delete"]) {
      expect(
        toolCallDiff({
          fileName: "empty.ts",
          diffStr: "",
          changes: [{ operation, path: "empty.ts" }],
        }).content,
      ).toEqual([
        {
          label: operation === "add" ? "Recorded content after" : "Recorded content before",
          text: "",
        },
      ]);
    }
    expect(toolCallDiff({ fileName: "a.ts", oldStr: "before", newStr: "" })).toEqual({
      patch: undefined,
      content: [
        { label: "Recorded content before", text: "before" },
        { label: "Recorded content after", text: "" },
      ],
      truncated: false,
    });
    expect(toolCallDiff({ fileName: "a.ts", newStr: "after" }).content).toEqual([
      { label: "Recorded content after", text: "after" },
    ]);
  });

  it("removes transport truncation markers before converting file contents", () => {
    const suffix = "\n… output truncated for transport";
    const diff = toolCallDiff({
      fileName: "a.ts",
      diffStr: `first\nsecond${suffix}`,
      changes: [{ operation: "add", path: "a.ts" }],
    });
    expect(diff.truncated).toBe(true);
    expect(diff.patch).not.toContain("output truncated");
    expect(renderedFiles(diff.patch)).toHaveLength(1);
    expect(toolCallDiff({ fileName: "a.ts", newStr: `content${suffix}` })).toMatchObject({
      content: [{ label: "Recorded content after", text: "content" }],
      truncated: true,
    });
  });

  it("preserves complete patches and unsupported provider output", () => {
    for (const operation of ["add", "delete"]) {
      const diffStr = [
        "diff --git a/a.ts b/a.ts",
        `--- ${operation === "add" ? "/dev/null" : "a/a.ts"}`,
        `+++ ${operation === "add" ? "b/a.ts" : "/dev/null"}`,
        operation === "add" ? "@@ -0,0 +1 @@" : "@@ -1 +0,0 @@",
        operation === "add" ? "+content" : "-content",
        "",
      ].join("\n");
      expect(
        toolCallDiff({ fileName: "a.ts", diffStr, changes: [{ operation, path: "a.ts" }] }).patch,
      ).toBe(diffStr);
    }
    for (const diffStr of [
      undefined,
      "",
      "provider output",
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    ]) {
      expect(
        toolCallDiff({ fileName: "a.ts", ...(diffStr === undefined ? {} : { diffStr }) }).patch,
      ).toBe(diffStr);
    }
  });
});
