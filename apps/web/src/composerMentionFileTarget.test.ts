import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMentionFileTarget } from "./composerMentionFileTarget";

const ROOT = "/Users/dev/t3code";

describe("resolveComposerMentionFileTarget", () => {
  it("passes workspace-relative mentions straight through", () => {
    expect(resolveComposerMentionFileTarget("AGENTS.md", ROOT)).toEqual({
      relativePath: "AGENTS.md",
    });
    expect(resolveComposerMentionFileTarget("apps/web/src/main.tsx", ROOT)).toEqual({
      relativePath: "apps/web/src/main.tsx",
    });
  });

  it("relativizes absolute mentions inside the workspace", () => {
    expect(resolveComposerMentionFileTarget(`${ROOT}/apps/web/src/main.tsx`, ROOT)).toEqual({
      relativePath: "apps/web/src/main.tsx",
    });
  });

  it("keeps extensionless filenames, which markdown link heuristics reject", () => {
    expect(resolveComposerMentionFileTarget("Makefile", ROOT)).toEqual({
      relativePath: "Makefile",
    });
  });

  it("collapses dot segments", () => {
    expect(resolveComposerMentionFileTarget("./docs/../AGENTS.md", ROOT)).toEqual({
      relativePath: "AGENTS.md",
    });
  });

  it("carries a :line suffix over as the reveal line", () => {
    expect(resolveComposerMentionFileTarget("apps/web/src/main.tsx:42", ROOT)).toEqual({
      relativePath: "apps/web/src/main.tsx",
      line: 42,
    });
    expect(resolveComposerMentionFileTarget("apps/web/src/main.tsx:42:7", ROOT)).toEqual({
      relativePath: "apps/web/src/main.tsx",
      line: 42,
    });
  });

  it("normalizes windows separators", () => {
    expect(resolveComposerMentionFileTarget("C:\\repo\\apps\\web\\main.tsx", "C:\\repo")).toEqual({
      relativePath: "apps/web/main.tsx",
    });
  });

  it("works for a workspace rooted at the filesystem root", () => {
    expect(resolveComposerMentionFileTarget("/srv/app/main.ts", "/")).toEqual({
      relativePath: "srv/app/main.ts",
    });
  });

  // Folding case here would accept a path from outside the workspace on a
  // case-sensitive filesystem.
  it("does not accept a root whose case does not match", () => {
    expect(resolveComposerMentionFileTarget("/users/dev/t3code/Other.ts", ROOT)).toBeNull();
  });

  // The filesystem behind a drive root does not distinguish these.
  it("matches a windows root case-insensitively", () => {
    expect(resolveComposerMentionFileTarget("C:\\Repo\\src\\file.ts", "C:\\repo")).toEqual({
      relativePath: "src/file.ts",
    });
  });

  it("still matches a windows root whose drive letter case differs", () => {
    expect(resolveComposerMentionFileTarget("c:\\repo\\apps\\main.tsx", "C:\\repo")).toEqual({
      relativePath: "apps/main.tsx",
    });
  });

  // `/..` is `/`, so climbing past an absolute root cannot leave `..` behind
  // for the file surface to walk.
  it("does not let a path climb above the root it resolves against", () => {
    expect(resolveComposerMentionFileTarget("../a/secret.ts", "/")).toEqual({
      relativePath: "a/secret.ts",
    });
    expect(resolveComposerMentionFileTarget("/x/../../a/secret.ts", "/")).toEqual({
      relativePath: "a/secret.ts",
    });
  });

  it("returns null outside the workspace, and without one", () => {
    expect(resolveComposerMentionFileTarget("/etc/hosts", ROOT)).toBeNull();
    expect(resolveComposerMentionFileTarget("../sibling/AGENTS.md", ROOT)).toBeNull();
    expect(resolveComposerMentionFileTarget("AGENTS.md", undefined)).toBeNull();
    expect(resolveComposerMentionFileTarget("   ", ROOT)).toBeNull();
  });
});
