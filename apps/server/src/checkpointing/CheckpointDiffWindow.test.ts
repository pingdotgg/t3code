import { describe, expect, it } from "vite-plus/test";
import { CHECKPOINT_DIFF_WINDOW_ROWS } from "@t3tools/contracts";
import { createCheckpointDiffWindow } from "./CheckpointDiffWindow.ts";

const header = "diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n";

describe("checkpoint diff windows", () => {
  it("reads a 200,000-line rebase through the final line with bounded responses", () => {
    const readers = [0, 99_840, 199_680].map(createCheckpointDiffWindow);
    const write = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      for (const reader of readers) reader.write(bytes);
    };
    write(`${header}@@ -1,100000 +1,100000 @@\n`);
    for (const marker of ["-", "+"]) {
      for (let index = 1; index <= 100_000; index += 1) {
        write(`${marker}${index}: ${"x".repeat(60)}\n`);
      }
    }
    const pages = readers.map((reader) => reader.finish("ignored buffered prefix"));
    expect(pages[0]!.files).toEqual([
      {
        path: "large.ts",
        previousPath: null,
        changeType: "change",
        additions: 100_000,
        deletions: 100_000,
        rowStart: 0,
        rowCount: 200_001,
        lineCount: 200_000,
        lineStarts: [{ lineIndex: 0, rowIndex: 1 }],
      },
    ]);
    for (const page of pages) {
      expect(page.rowCount).toBe(200_001);
      expect(page.rows.length).toBeLessThanOrEqual(CHECKPOINT_DIFF_WINDOW_ROWS);
      expect(page.revision).toBe(pages[0]!.revision);
    }
    expect(pages[1]!.rows.find((row) => row.index === 100_001)).toMatchObject({
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
      lineIndex: 100_000,
    });
    expect(pages[2]!.rows.at(-1)).toMatchObject({
      index: 200_000,
      newLineNumber: 100_000,
      lineIndex: 199_999,
    });
  });

  it("keeps hunks, Unicode, missing final newlines, renames and binary files across byte boundaries", () => {
    const patch = [
      'diff --git "a/old\\tname" "b/new\\tname"',
      'rename from "old\\tname"',
      'rename to "new\\tname"',
      '--- "a/old\\tname"',
      '+++ "b/new\\tname"',
      "@@ -10,2 +20,2 @@ hello",
      " context",
      "-before",
      "+世界🌍",
      "\\ No newline at end of file",
      "diff --git a/image.png b/image.png",
      "Binary files a/image.png and b/image.png differ",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+last",
    ].join("\n");
    const reader = createCheckpointDiffWindow(0);
    for (const byte of new TextEncoder().encode(patch)) reader.write(Uint8Array.of(byte));
    const page = reader.finish("");
    expect(page.files.map((file) => [file.path, file.previousPath, file.changeType])).toEqual([
      ["new\tname", "old\tname", "rename-changed"],
      ["image.png", null, "change"],
      ["new.txt", null, "new"],
    ]);
    expect(page.rows[3]).toMatchObject({
      content: "世界🌍",
      oldLineNumber: null,
      newLineNumber: 21,
    });
    expect(page.rows[4]).toMatchObject({ kind: "hunk", content: "\\ No newline at end of file" });
    expect(page.rows[5]!.kind).toBe("notice");
    expect(page.rows.at(-1)).toMatchObject({ content: "last", newLineNumber: 1, fileIndex: 2 });
  });

  it("returns complete file metadata even when the requested window is past the end", () => {
    const reader = createCheckpointDiffWindow(1000);
    expect(reader.finish(`${header}@@ -1 +1 @@\n-before\n+after\n`)).toMatchObject({
      rowCount: 3,
      rows: [],
      files: [{ additions: 1, deletions: 1, rowCount: 3 }],
    });
  });
});
