import { describe, expect, it } from "vite-plus/test";

import {
  fileRoutePathSegments,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  needsWorkspaceFileContents,
  resolveAgentFileLinkPath,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

describe("resolveAgentFileLinkPath", () => {
  it.each([
    ["/wt/ios", "/wt", "src/a.ts", "ios/src/a.ts"],
    ["/wt/ios", "/wt", "../shared/file.ts", "shared/file.ts"],
    ["/wt/ios", "/wt", "../../etc/passwd", null],
    ["/wt/ios", "/wt", "/wt/README.md", "/wt/README.md"],
    ["/wt/ios", "/wt", "~notes.md", "ios/~notes.md"],
    ["/home/maria/wt/ios", "/home/maria/wt", "~/notes.md", "/home/maria/notes.md"],
    ["/wt", "/wt", "src/a.ts", "src/a.ts"],
    [null, "/wt", "src/a.ts", "src/a.ts"],
  ])("resolves a link from %s in %s: %s", (agentCwd, workspaceRoot, path, expected) => {
    expect(resolveAgentFileLinkPath(agentCwd, workspaceRoot, path)).toBe(expected);
  });
});

describe("resolveFileLinkPath", () => {
  it.each([
    ["/home/maria/project", "~/.agents/AGENTS.md", "/home/maria/.agents/AGENTS.md"],
    ["/Users/maria/project", "~/notes.md", "/Users/maria/notes.md"],
    ["C:\\Users\\maria\\project", "~\\.agents\\AGENTS.md", "C:\\Users\\maria\\.agents\\AGENTS.md"],
  ])("expands a home link from %s", (cwd, path, expected) => {
    expect(resolveFileLinkPath(cwd, path)).toBe(expected);
    expect(fileRoutePathSegments(expected).join("/")).toBe(expected);
  });

  it("does not turn an unresolved home into a workspace path", () => {
    expect(resolveFileLinkPath("/repo", "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath(null, "~/notes.md")).toBeNull();
    expect(resolveFileLinkPath("/repo", "../notes.md")).toBeNull();
  });
});

describe("resolveWorkspaceRelativeFilePath", () => {
  it("converts absolute paths inside the workspace", () => {
    expect(
      resolveWorkspaceRelativeFilePath("/Users/julius/repo", "/Users/julius/repo/src/main.ts"),
    ).toBe("src/main.ts");
    expect(resolveWorkspaceRelativeFilePath("C:\\repo", "c:\\repo\\src\\main.ts")).toBe(
      "src/main.ts",
    );
  });

  it("recognizes home links inside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/home/maria/project", "~/project/src/main.ts")).toBe(
      "src/main.ts",
    );
    expect(
      resolveWorkspaceRelativeFilePath("/home/maria/project", "~/.agents/AGENTS.md"),
    ).toBeNull();
  });

  it("rejects paths outside the workspace", () => {
    expect(resolveWorkspaceRelativeFilePath("/repo", "/other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "../other/main.ts")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath("/repo", "/repo/../outside.txt")).toBeNull();
    expect(resolveWorkspaceRelativeFilePath(null, "/repo/main.ts")).toBeNull();
  });
});

describe("needsWorkspaceFileContents", () => {
  it("reads a text file while its metadata is still pending, but not a directory", () => {
    const input = { relativePath: "package.json", activeMode: "source" } as const;
    expect(needsWorkspaceFileContents({ ...input, metadataKind: undefined })).toBe(true);
    expect(needsWorkspaceFileContents({ ...input, metadataKind: "directory" })).toBe(false);
  });
});

describe("workspace preview classifiers", () => {
  it("treat # and ? as literal filename characters", () => {
    for (const path of ["notes/clip#1.wav", "notes/clip?1.wav", "notes#old/clip.wav"]) {
      expect(isAudioPreviewFile(path)).toBe(true);
    }
    for (const path of ["docs/draft#1.md", "docs/draft?1.md", "docs#old/draft.md"]) {
      expect(isMarkdownPreviewFile(path)).toBe(true);
    }
  });
});
