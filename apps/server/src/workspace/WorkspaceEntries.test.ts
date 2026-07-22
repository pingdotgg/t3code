// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: { cwd: string; query: string; limit: number }) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcessPlatform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("returns the complete cached workspace index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "src", kind: "directory" },
            { path: "src/components", kind: "directory" },
            {
              path: "src/components/Composer.tsx",
              kind: "file",
            },
            { path: "README.md", kind: "file" },
          ]),
        );
        expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("search", () => {
    it.effect("returns files and directories relative to cwd", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, ".git/HEAD");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
        expect(paths).toContain("README.md");
        expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("filters and ranks entries by query", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.entries.some((entry) => entry.path === "src/components")).toBe(true);
        expect(result.entries.every((entry) => entry.path.toLowerCase().includes("compo"))).toBe(
          true,
        );
      }),
    );

    it.effect("supports fuzzy subsequence queries for composer path search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
        const paths = result.entries.map((entry) => entry.path);

        expect(result.entries.length).toBeGreaterThan(0);
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
      }),
    );

    it.effect("prioritizes exact basename matches ahead of broader path matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-exact-ranking-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "docs/composer.tsx-notes.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "Composer.tsx", limit: 5 });

        expect(result.entries[0]?.path).toBe("src/components/Composer.tsx");
      }),
    );

    it.effect("tracks truncation without sorting every fuzzy match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-limit-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

        expect(result.entries).toHaveLength(1);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("excludes .convex in non-git workspaces", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-non-git-convex-" });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("supports typo-resistant file search through fff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fff-typo-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compoesr", limit: 10 });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "src/components/Composer.tsx" }),
          ]),
        );
      }),
    );

    it.effect("rebuilds the cached index after refresh fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-refresh-failure-" });
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const createSpy = vi.spyOn(FileFinder, "create");
        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(1);

        vi.spyOn(FileFinder.prototype, "scanFiles").mockReturnValueOnce({
          ok: false,
          error: "scan failed",
        });
        yield* workspaceEntries.refresh(cwd);

        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(2);
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("returns content matches with file paths, line numbers, and ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-search-" });
        yield* writeTextFile(
          cwd,
          "src/shapes.ts",
          "export const square = 4;\nexport const Square = 16;\nexport const squareSize = 8;\n",
        );
        yield* writeTextFile(cwd, "src/other.ts", "const circle = true;\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: false,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches.map((match) => [match.path, match.lineNumber])).toEqual([
          ["src/shapes.ts", 1],
          ["src/shapes.ts", 2],
        ]);
        expect(result.matches[0]?.matchRanges).toEqual([{ start: 13, end: 19 }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("honors case sensitivity and gitignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-ignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "square\nSquare\n");
        yield* writeTextFile(cwd, "ignored.txt", "Square\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "Square",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({ path: "src/keep.ts", lineNumber: 2 });
      }),
    );

    it.effect("matches punctuation-ended literal queries as whole words", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "foo- foo-bar foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
          matchRanges: [
            { start: 0, end: 4 },
            { start: 13, end: 17 },
          ],
        });
      }),
    );

    it.effect("matches punctuation-ended regex queries as whole words", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "foo- foo-bar foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo-",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: true,
        });

        // wholeWord + useRegex must not silently drop non-word-edged patterns like "foo-"
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]).toMatchObject({
          path: "src/words.ts",
          lineNumber: 1,
        });
        expect(result.matches[0]?.matchRanges).toHaveLength(2);
      }),
    );

    it.effect("preserves regex escapes during case-insensitive searches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-regex-" });
        yield* writeTextFile(cwd, "src/shapes.ts", "Square\nsquare\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "\\SQUARE",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        });

        expect(result.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );
  });

  describe("browse", () => {
    it.effect("returns matching directories and excludes files", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-prefix-" });
        yield* writeTextFile(cwd, "alphabet.txt", "ignore me");
        yield* writeTextFile(cwd, "alpha/index.ts", "export {};\n");
        yield* writeTextFile(cwd, "alpine/index.ts", "export {};\n");

        const result = yield* workspaceEntries.browse({
          partialPath: path.join(cwd, "alp"),
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [
            { name: "alpha", fullPath: path.join(cwd, "alpha") },
            { name: "alpine", fullPath: path.join(cwd, "alpine") },
          ],
        });
      }),
    );

    it.effect("shows dot directories in directory mode and hidden-prefix mode", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");
        const cwdWithSeparator = yield* appendSeparator(cwd);

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: cwdWithSeparator,
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${cwdWithSeparator}.c`,
        });

        expect(directoryResult.entries.map((entry) => entry.name)).toEqual([".config", "config"]);
        expect(hiddenPrefixResult).toEqual({
          parentPath: cwd,
          entries: [{ name: ".config", fullPath: path.join(cwd, ".config") }],
        });
      }),
    );

    it.effect("supports relative paths when cwd is provided", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-relative-" });
        yield* writeTextFile(cwd, "packages/pkg.json", "{}");

        const result = yield* workspaceEntries.browse({
          cwd,
          partialPath: "./pack",
        });

        expect(result).toEqual({
          parentPath: cwd,
          entries: [{ name: "packages", fullPath: path.join(cwd, "packages") }],
        });
      }),
    );

    it.effect("rejects relative paths without cwd", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

        const error = yield* workspaceEntries
          .browse({
            partialPath: "./src",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceEntriesCurrentProjectRequiredError");
        expect(error.message).toBe(
          "A current project is required to browse relative workspace path './src'.",
        );
      }),
    );

    it.effect("returns an empty listing when the OS denies directory access", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-eacces-" });

        const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        vi.mocked(NodeFSP.readdir).mockRejectedValueOnce(denied);

        const result = yield* workspaceEntries.browse({
          partialPath: yield* appendSeparator(cwd),
        });
        expect(result).toEqual({ parentPath: cwd, entries: [] });
      }),
    );
  });
});
