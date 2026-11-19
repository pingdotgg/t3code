import * as NodeModule from "node:module";

import { getPathFromState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

import { fileScreenLinking, getStackStateFromPath } from "../../stackLinking";
import {
  fileRoutePathSegments,
  isAudioPreviewFile,
  isMarkdownPreviewFile,
  needsWorkspaceFileContents,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "./filePath";

vi.mock("@react-navigation/native", () => {
  const requireFromNative = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return requireFromNative("@react-navigation/core") as typeof import("@react-navigation/native");
});

describe("file screen links", () => {
  const config = { screens: fileScreenLinking };

  it.each([
    [
      "threads/env-1/thread-1/files/packages/expo-development-client.ts",
      "packages/expo-development-client.ts",
    ],
    ["threads/env-1/thread-1/files/README.md?line=3", "README.md"],
    ["threads/env-1/thread-1/files/a%20b/c.ts", "a b/c.ts"],
  ])("opens the file a link names: %s", (link, path) => {
    expect(getStackStateFromPath(link, config)?.routes.at(-1)).toMatchObject({
      name: "ThreadFile",
      params: { environmentId: "env-1", threadId: "thread-1", path },
    });
  });

  describe.each([
    {
      name: "ThreadFile",
      prefix: "/threads/env-1/thread-1/files",
      params: { environmentId: "env-1", threadId: "thread-1" },
    },
    {
      name: "NewTaskFile",
      prefix: "/new/draft/files",
      params: { environmentId: "env-1", cwd: "/repo" },
    },
  ])("$name", ({ name, prefix, params }) => {
    it("opens a nested file at the linked line", () => {
      expect(
        getStackStateFromPath(
          `${prefix}/docs/chapter%201.md?environmentId=env-1&cwd=%2Frepo&line=3`,
          config,
        )?.routes.at(-1),
      ).toMatchObject({
        name,
        params: { ...params, cwd: "/repo", path: "docs/chapter 1.md", line: "3" },
      });
    });

    it.each([
      { segments: ["docs", "probe #1.md"], path: "docs/probe #1.md" },
      { segments: ["", "repo", "probe.md"], path: "/repo/probe.md" },
      { segments: ["undefined"], path: "undefined" },
    ])("round-trips the file $path", ({ segments, path }) => {
      const link = getPathFromState(
        { routes: [{ name, params: { ...params, path: segments } }] },
        config,
      );
      expect(link.split("?")[0]).toBe(`${prefix}/${encodeURIComponent(path)}`);
      expect(getStackStateFromPath(link, config)?.routes.at(-1)).toMatchObject({
        name,
        params: { ...params, path },
      });
    });

    it("opens a saved link with path segments in the query", () => {
      expect(
        getStackStateFromPath(
          `${prefix}/undefined?environmentId=env-1&cwd=%2Frepo&path=docs&path=a%2Bb.md&line=3`,
          config,
        )?.routes.at(-1),
      ).toMatchObject({
        name,
        params: { ...params, cwd: "/repo", path: ["docs", "a+b.md"], line: "3" },
      });
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
