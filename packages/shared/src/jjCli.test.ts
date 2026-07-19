import { describe, expect, it } from "vite-plus/test";

import {
  JJ_MINIMUM_SUPPORTED_VERSION,
  classifyJjCommandFailure,
  classifyJjRevisionCondition,
  inspectJjVersion,
  isJjBookmarkRecord,
  isJjChangedFileRecord,
  isJjRevisionRecord,
  parseJjJsonLines,
  parseJjVersionOutput,
  quoteJjRootFileFileset,
  quoteJjSymbol,
} from "./jjCli.ts";

describe("jj CLI contract", () => {
  it("parses release and prerelease version output", () => {
    expect(parseJjVersionOutput("jj 0.42.0\n")).toBe("0.42.0");
    expect(parseJjVersionOutput("jj v0.43.0-rc.1\n")).toBe("0.43.0-rc.1");
    expect(parseJjVersionOutput("jj 0.43.0+build.7\n")).toBe("0.43.0");
    expect(parseJjVersionOutput("unexpected")).toBeNull();
  });

  it("rejects versions below the supported floor with an actionable detail", () => {
    expect(inspectJjVersion("jj 0.41.0")).toEqual({
      status: "unsupported",
      version: "0.41.0",
      minimumVersion: JJ_MINIMUM_SUPPORTED_VERSION,
      detail: `Jujutsu 0.41.0 is unsupported. T3 Code requires jj ${JJ_MINIMUM_SUPPORTED_VERSION} or newer.`,
    });
    expect(inspectJjVersion(`jj ${JJ_MINIMUM_SUPPORTED_VERSION}`)).toEqual({
      status: "supported",
      version: JJ_MINIMUM_SUPPORTED_VERSION,
    });
  });

  it("treats jj source revision suffixes as packaging metadata", () => {
    const sourceRevision = "b8f7c455170e3273897aaf94431f8ccfb1afa7ad";

    expect(inspectJjVersion(`jj 0.42.0-${sourceRevision}`)).toEqual({
      status: "supported",
      version: `0.42.0-${sourceRevision}`,
    });
    expect(inspectJjVersion(`jj 0.41.0-${sourceRevision}`).status).toBe("unsupported");
    expect(inspectJjVersion("jj 0.42.0-rc.1").status).toBe("unsupported");
  });

  it("round-trips JSON lines containing control characters and Unicode", () => {
    const records = [
      { path: "space snow-雪.txt", description: "line one\nline\ttwo" },
      { path: "line\nbreak.txt", description: 'quote: "' },
    ];
    const output = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

    expect(parseJjJsonLines(output)).toEqual(records);
  });

  it("quotes revset symbols without shell interpolation", () => {
    for (const name of ["feature space", "unicode-雪", "tab\tname", "line\nname", 'quote"name']) {
      expect(JSON.parse(quoteJjSymbol(name))).toBe(name);
    }
    expect(() => quoteJjSymbol("nul\0name")).toThrow("NUL");
  });

  it("quotes exact workspace-relative file paths as root-file filesets", () => {
    for (const filePath of [
      "src/file.ts",
      "space snow-雪.txt",
      "tab\tname.txt",
      "line\nbreak.txt",
      'quote"name.txt',
    ]) {
      const fileset = quoteJjRootFileFileset(filePath);
      expect(fileset.startsWith("root-file:")).toBe(true);
      expect(JSON.parse(fileset.slice("root-file:".length))).toBe(filePath);
    }

    for (const invalidPath of ["", "/tmp/file", "../file", "src/../file", "C:\\tmp\\file"]) {
      expect(() => quoteJjRootFileFileset(invalidPath)).toThrow();
    }
  });

  it.each([
    ["Error: There is no jj repo in .", 1, "not-repository"],
    ["Working copy is stale. Run `jj workspace update-stale`.", 1, "stale-workspace"],
    ["Error: Revision doesn't exist: missing", 1, "unresolved-revision"],
    ["Error: Bookmark main is conflicted", 1, "bookmark-conflict"],
    ["fatal: Authentication failed", 1, "authentication"],
    ["Error: Refusing to push bookmark because it unexpectedly moved", 1, "push-rejected"],
    ["Warning: Failed to export some bookmarks: not a valid ref name", 0, "invalid-ref"],
    ["unknown failure", 2, "command-failed"],
    ["", 0, null],
  ] as const)("classifies %s", (stderr, exitCode, expected) => {
    expect(classifyJjCommandFailure({ stderr, exitCode })).toBe(expected);
  });

  it("classifies content conflicts from structured revision data", () => {
    expect(classifyJjRevisionCondition({ conflict: true })).toBe("content-conflict");
    expect(classifyJjRevisionCondition({ conflict: false })).toBeNull();
  });

  it("validates revision, file, and bookmark machine records", () => {
    expect(
      isJjRevisionRecord({
        commitId: "abc",
        changeId: "change",
        description: "message",
        conflict: false,
        empty: true,
        parents: ["parent"],
        workingCopies: [],
      }),
    ).toBe(true);
    expect(isJjChangedFileRecord({ path: "file.txt", status: "renamed", conflict: true })).toBe(
      true,
    );
    expect(isJjChangedFileRecord({ path: "file.txt", status: ["renamed"], conflict: true })).toBe(
      false,
    );
    expect(
      isJjBookmarkRecord({
        name: "main",
        remote: "origin",
        target: ["abc"],
        tracking_target: ["def"],
      }),
    ).toBe(true);
    expect(isJjBookmarkRecord({ name: "broken", target: "abc" })).toBe(false);
  });
});
