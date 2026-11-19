import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

import {
  FILE_ROUTE_PATH_PARAM,
  fileRoutePathSegments,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  needsWorkspaceFileContents,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { getStateFromPath } = requireFromNative("@react-navigation/core") as {
  readonly getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};

describe("FILE_ROUTE_PATH_PARAM", () => {
  const config = {
    screens: {
      ThreadFiles: "threads/:environmentId/:threadId/files",
      ThreadFile: `threads/:environmentId/:threadId/files/${FILE_ROUTE_PATH_PARAM}`,
      NotFound: "*",
    },
  };

  it.each([
    [
      "threads/env-1/thread-1/files/packages/expo-development-client.ts",
      "packages/expo-development-client.ts",
    ],
    ["threads/env-1/thread-1/files/README.md?line=3", "README.md"],
    ["threads/env-1/thread-1/files/a%20b/c.ts", "a b/c.ts"],
  ])("opens the file a link names: %s", (link, path) => {
    expect(getStateFromPath(link, config)?.routes.at(-1)).toMatchObject({
      name: "ThreadFile",
      params: { environmentId: "env-1", threadId: "thread-1", path },
    });
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
  it("recognize preview extensions and treat # and ? as literal filename characters", () => {
    for (const path of ["notes/clip#1.wav", "notes/clip?1.wav", "notes#old/clip.wav"]) {
      expect(isAudioPreviewFile(path)).toBe(true);
    }
    for (const path of [
      "docs/draft#1.md",
      "docs/draft?1.md",
      "docs#old/draft.md",
      "CHANGELOG.markdown",
      "notes.MDOWN",
      "todo.mkd",
    ]) {
      expect(isMarkdownPreviewFile(path)).toBe(true);
    }
  });
});
