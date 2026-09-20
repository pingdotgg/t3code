import { DiffHunksRenderer, hydratePartialDiff, parsePatchFiles } from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { describe, expect, it } from "vite-plus/test";

describe.each(["clone", "merge"] as const)("review editor %s hydration", (mode) => {
  it.each(["unified", "split"] as const)(
    "keeps hunks valid after %s line edits",
    async (diffStyle) => {
      const contents = Array.from(
        { length: 30 },
        (_, index) => `const line${index + 1} = ${index + 1};\n`,
      ).join("");
      const partial = parsePatchFiles(
        [
          "diff --git a/file.ts b/file.ts",
          "--- a/file.ts",
          "+++ b/file.ts",
          "@@ -10,3 +10,3 @@",
          " const line10 = 10;",
          "-const line11 = 11;",
          "+const line11 = 42;",
          " const line12 = 12;",
          "",
        ].join("\n"),
      )[0]!.files[0]!;
      const renderer = new DiffHunksRenderer({ diffStyle });
      renderer.beginEditSession(partial);
      const diff = hydratePartialDiff(mode, partial, {
        oldFile: { name: "file.ts", contents },
        newFile: { name: "file.ts", contents: contents.replace("line11 = 11", "line11 = 42") },
      });
      await renderer.initializeHighlighter();
      renderer.renderDiff(diff);
      const document = new TextDocument("file.ts", diff.additionLines.join(""));
      document.applyEdits([
        {
          range: { start: { line: 10, character: 18 }, end: { line: 10, character: 18 } },
          newText: "\n",
        },
      ]);
      renderer.applyDocumentChange(document);
      expect(() => renderer.renderDiff(diff)).not.toThrow();
      expect(diff.additionLines.join("")).toBe(document.getText());
      expect(diff.hunks).toHaveLength(1);
      expect(diff.hunks[0]).toMatchObject({ additionCount: 4, deletionCount: 3 });
      document.applyEdits([
        {
          range: { start: { line: 10, character: 18 }, end: { line: 11, character: 0 } },
          newText: "",
        },
      ]);
      renderer.applyDocumentChange(document);
      expect(() => renderer.renderDiff(diff)).not.toThrow();
      expect(diff.additionLines.join("")).toBe(contents.replace("line11 = 11", "line11 = 42"));
      expect(diff.hunks[0]).toMatchObject({ additionCount: 3, deletionCount: 3 });
      renderer.cleanUp();
    },
  );
});
