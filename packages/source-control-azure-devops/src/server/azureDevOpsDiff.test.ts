import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsFilePatch,
  byteLength,
  MAX_FILE_DIFF_EDITS,
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

  it("takes the host's word that a file is binary, whatever its bytes look like", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "logo.png", oldPath: "logo.png" }),
      texts: texts("b2xk", "bmV3", true),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toContain("Binary files a/logo.png and b/logo.png differ");
  });

  it("counts an overlong file in bytes rather than in characters", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "notes.md", oldPath: "notes.md" }),
      texts: texts("\u4e00".repeat(200_000), "\u4e8c".repeat(200_000)),
    });

    expect(patch.truncated).toBe(true);
    expect(patch.section).toBe(
      ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", ""].join("\n"),
    );
  });

  it("lists a file too far apart to diff without its hunks", () => {
    const lines = (prefix: string) =>
      Array.from({ length: MAX_FILE_DIFF_EDITS }, (_, line) => `${prefix} ${line}`).join("\n");
    const patch = azureDevOpsFilePatch({
      change: change({ path: "generated.ts", oldPath: "generated.ts" }),
      texts: texts(`${lines("old")}\n`, `${lines("new")}\n`),
    });

    expect(patch.truncated).toBe(true);
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

  it("keeps a wholly new file too heavy to write out listed without its hunks", () => {
    const contents = `${Array.from({ length: 200_000 }, () => "x").join("\n")}\n`;
    const patch = azureDevOpsFilePatch({
      change: change({ path: "bundle.min.js", oldPath: "bundle.min.js", changeKind: "new" }),
      texts: texts("", contents),
    });

    expect(byteLength(contents)).toBeLessThan(512 * 1024);
    expect(patch.truncated).toBe(true);
    expect(patch.abandoned).toBe(false);
    expect(patch.edits).toBe(200_000);
    expect(patch.section).toBe(
      [
        "diff --git a/bundle.min.js b/bundle.min.js",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/bundle.min.js",
        "",
      ].join("\n"),
    );
  });

  it("gives an empty new file no hunk to read", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "EMPTY.md", oldPath: "EMPTY.md", changeKind: "new" }),
      texts: texts("", ""),
    });

    expect(patch.edits).toBe(0);
    expect(patch.section).not.toContain("@@");
  });

  it("marks a wholly new file whose last line has no newline after it", () => {
    const patch = azureDevOpsFilePatch({
      change: change({ path: "NOTES.md", oldPath: "NOTES.md", changeKind: "new" }),
      texts: texts("", "one\ntwo"),
    });

    expect(patch.section).toBe(
      [
        "diff --git a/NOTES.md b/NOTES.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/NOTES.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });
});

describe("a file Azure names something a patch header cannot carry plainly", () => {
  it("quotes the names a rename states, which carry no side letter", () => {
    const patch = azureDevOpsFilePatch({
      change: change({
        path: "docs/new\tname.md",
        oldPath: "docs/old\tname.md",
        changeKind: "rename-pure",
      }),
      texts: texts("same\n", "same\n"),
    });

    expect(patch.section).toBe(
      [
        'diff --git "a/docs/old\\tname.md" "b/docs/new\\tname.md"',
        'rename from "docs/old\\tname.md"',
        'rename to "docs/new\\tname.md"',
        '--- "a/docs/old\\tname.md"',
        '+++ "b/docs/new\\tname.md"',
        "",
      ].join("\n"),
    );
  });

  it("hands a reader of the header back the name Azure gave", () => {
    const path = 'every\t\n"kind"\\of.md';
    const patch = azureDevOpsFilePatch({
      change: change({ path, oldPath: path }),
      texts: texts("one\n", "two\n"),
    });
    const [header, oldLine, newLine] = patch.section.split("\n");

    expect(header).not.toContain("\t");
    expect(unquoteGitPatchPath(oldLine?.slice(4) ?? "")).toBe(`a/${path}`);
    expect(unquoteGitPatchPath(newLine?.slice(4) ?? "")).toBe(`b/${path}`);
  });
});

describe("a diff cursor", () => {
  it("reads anything it did not write as no position at all", () => {
    for (const raw of [undefined, null, "", "abc", "1", "0:4", "1:-2", "1:2:3"]) {
      expect(parseAzureDevOpsDiffCursor(raw)).toBeNull();
    }
  });
});
