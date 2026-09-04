import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsFilePatch,
  azureDevOpsUnreadableFilePatch,
  formatAzureDevOpsDiffCursor,
  parseAzureDevOpsDiffCursor,
} from "./azureDevOpsDiff.ts";
import type { AzureDevOpsChangeEntry } from "./azureDevOpsPullRequestJson.ts";

function change(overrides: Partial<AzureDevOpsChangeEntry> = {}): AzureDevOpsChangeEntry {
  return {
    path: "README.md",
    oldPath: "README.md",
    changeKind: "change",
    objectId: "8f80",
    originalObjectId: "0ca4",
    ...overrides,
  };
}

function texts(oldContents: string, newContents: string, binary = false) {
  return { oldContents, newContents, binary };
}

describe("azureDevOpsFilePatch", () => {
  it("writes a changed file as the unified patch every diff viewer already reads", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\ntwo\nthree\n", "one\ntwo again\nthree\n"),
    });

    expect(patch.truncated).toBe(false);
    expect(patch.section).toBe(
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1,3 +1,3 @@",
        " one",
        "-two",
        "+two again",
        " three",
        "",
      ].join("\n"),
    );
  });

  it("names the side a new file does not have as /dev/null", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "DEMO.md", oldPath: "DEMO.md", changeKind: "new" }),
      texts: texts("", "hello\n"),
    });

    expect(patch.section).toContain("new file mode 100644");
    expect(patch.section).toContain("--- /dev/null");
    expect(patch.section).toContain("+++ b/DEMO.md");
    // Git points the range a new file does not have at line zero, not at line one.
    expect(patch.section).toContain("@@ -0,0 +1 @@");
    expect(patch.section).toContain("+hello");
  });

  it("names the side a deleted file no longer has as /dev/null", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "OLD.md", oldPath: "OLD.md", changeKind: "deleted" }),
      texts: texts("gone\n", ""),
    });

    expect(patch.section).toContain("deleted file mode 100644");
    expect(patch.section).toContain("--- a/OLD.md");
    expect(patch.section).toContain("+++ /dev/null");
    expect(patch.section).toContain("@@ -1 +0,0 @@");
    expect(patch.section).toContain("-gone");
  });

  it("keeps the carriage returns of a file with Windows line endings", () => {
    // They are part of the line rather than around it, so a patch that dropped them would ask
    // the reader to look at a change that is not the one on the host.
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\r\ntwo\r\n", "one\r\ntwo again\r\n"),
    });

    expect(patch.section).toContain("-two\r");
    expect(patch.section).toContain("+two again\r");
  });

  it("keeps a file that only moved, which has no hunks to give", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "docs/new.md", oldPath: "docs/old.md", changeKind: "rename-pure" }),
      texts: texts("same\n", "same\n"),
    });

    expect(patch.truncated).toBe(false);
    expect(patch.section).toBe(
      [
        "diff --git a/docs/old.md b/docs/new.md",
        "rename from docs/old.md",
        "rename to docs/new.md",
        "--- a/docs/old.md",
        "+++ b/docs/new.md",
        "",
      ].join("\n"),
    );
  });

  it("reports a binary file as changed rather than spelling it out", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("PNG\u0000old", "PNG\u0000new"),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("shows an overlong file as changed without its hunks", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "bundle.js", oldPath: "bundle.js" }),
      texts: texts("a\n".repeat(400_000), "b\n".repeat(400_000)),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/bundle.js b/bundle.js", "--- a/bundle.js", "+++ b/bundle.js", ""].join("\n"),
    );
  });

  it("takes the host's word that a file is binary, whatever its bytes look like", () => {
    // Azure hands such a file over base64-encoded, so nothing in the text it sent gives it away.
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("b2xk", "bmV3", true),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("counts an overlong file in bytes rather than in characters", () => {
    // Three bytes each, so a ceiling counted in code units would let three times the size through.
    const patch = azureDevOpsFilePatch({
      change: change({ path: "notes.md", oldPath: "notes.md" }),
      texts: texts("\u4e00".repeat(200_000), "\u4e8c".repeat(200_000)),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", ""].join("\n"),
    );
  });

  it("gives up on a file whose two sides are too far apart to diff in the time allowed", () => {
    // The line diff costs the product of the two sides, so a pair under the size ceiling that
    // shares nothing still runs long. Left to itself it would hold the server for as long as it
    // took; here it is given a millisecond so the giving up is the thing being read.
    const oldContents = Array.from({ length: 3_000 }, (_, line) => `old ${line}`).join("\n");
    const newContents = Array.from({ length: 3_000 }, (_, line) => `new ${line}`).join("\n");
    const patch = azureDevOpsFilePatch({
      change: change({ path: "generated.ts", oldPath: "generated.ts" }),
      texts: texts(oldContents, newContents),
      timeoutMillis: 1,
    });

    expect(patch.truncated).toBe(true);
    // And it says so, because the reader of a run of files is meant to stop rather than spend
    // that time again on each of the ones behind it.
    expect(patch.abandoned).toBe(true);
    expect(patch.section).toBe(
      [
        "diff --git a/generated.ts b/generated.ts",
        "--- a/generated.ts",
        "+++ b/generated.ts",
        "",
      ].join("\n"),
    );
  });

  it("keeps a file it did diff out of the giving up", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\ntwo\n", "one\ntwo again\n"),
    });

    expect(patch.abandoned).toBe(false);
  });

  it("marks a file that does not end in a newline, as git does", () => {
    const patch = azureDevOpsFilePatch({
      change: change(),
      texts: texts("one\n", "two"),
    });

    expect(patch.section).toContain("\\ No newline at end of file");
  });
});

describe("azureDevOpsUnreadableFilePatch", () => {
  it("keeps a file the host would not hand over, listed without its hunks", () => {
    const patch = azureDevOpsUnreadableFilePatch(change({ path: "huge.bin", oldPath: "huge.bin" }));

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/huge.bin b/huge.bin", "--- a/huge.bin", "+++ b/huge.bin", ""].join("\n"),
    );
  });
});

describe("a diff cursor", () => {
  it("carries the push it was taken against back to the next slice", () => {
    const cursor = formatAzureDevOpsDiffCursor({ iterationId: 3, fileIndex: 12 });

    expect(parseAzureDevOpsDiffCursor(cursor)).toEqual({ iterationId: 3, fileIndex: 12 });
  });

  it("reads anything it did not write as no position at all", () => {
    // Which starts the read from the top rather than failing it: a cursor is the client's to
    // hand back, and nothing downstream is worth refusing a whole diff over.
    for (const raw of [undefined, null, "", "abc", "1", "0:4", "1:-2", "1:2:3"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });

  it("refuses a half it did not write rather than reading it as the first file", () => {
    // `Number` is wider than the cursor: an empty, padded or hex half would otherwise pass as a
    // position, and the read would resume against an iteration the client never saw instead of
    // starting again from the latest one.
    for (const raw of ["1:", ":4", "1: ", " 1:4", "1:0x2", "0x1:2", "1e2:0", "1:4.0"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });
});
