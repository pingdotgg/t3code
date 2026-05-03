import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, afterEach, describe, expect, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
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
    const workspaceEntries = yield* WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  input.endsWith("/") || input.endsWith("\\")
    ? input
    : `${input}${process.platform === "win32" ? "\\" : "/"}`;

it.layer(TestLayer)("WorkspaceEntriesLive", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    it.effect("deduplicates concurrent index builds for the same cwd", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-concurrent-build-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");

        let rootReadCount = 0;
        const originalReaddir = fsPromises.readdir.bind(fsPromises);
        vi.spyOn(fsPromises, "readdir").mockImplementation((async (
          ...args: Parameters<typeof fsPromises.readdir>
        ) => {
          if (args[0] === cwd) {
            rootReadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return originalReaddir(...args);
        }) as typeof fsPromises.readdir);

        yield* Effect.all(
          [
            searchWorkspaceEntries({ cwd, query: "", limit: 100 }),
            searchWorkspaceEntries({ cwd, query: "comp", limit: 100 }),
            searchWorkspaceEntries({ cwd, query: "src", limit: 100 }),
          ],
          { concurrency: "unbounded" },
        );

        expect(rootReadCount).toBe(1);
      }),
    );

    it.effect("limits concurrent directory reads while walking the filesystem", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-read-concurrency-" });
        yield* Effect.forEach(
          Array.from({ length: 80 }, (_, index) => index),
          (index) => writeTextFile(cwd, `group-${index}/entry-${index}.ts`, "export {};"),
          { discard: true },
        );

        let activeReads = 0;
        let peakReads = 0;
        const originalReaddir = fsPromises.readdir.bind(fsPromises);
        vi.spyOn(fsPromises, "readdir").mockImplementation((async (
          ...args: Parameters<typeof fsPromises.readdir>
        ) => {
          const target = args[0];
          if (typeof target === "string" && target.startsWith(cwd)) {
            activeReads += 1;
            peakReads = Math.max(peakReads, activeReads);
            await new Promise((resolve) => setTimeout(resolve, 4));
            try {
              return await originalReaddir(...args);
            } finally {
              activeReads -= 1;
            }
          }
          return originalReaddir(...args);
        }) as typeof fsPromises.readdir);

        yield* searchWorkspaceEntries({ cwd, query: "", limit: 200 });

        expect(peakReads).toBeLessThanOrEqual(32);
      }),
    );
  });

  describe("browse", () => {
    it.effect("returns matching directories and excludes files", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
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
        const workspaceEntries = yield* WorkspaceEntries;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-browse-hidden-" });
        yield* writeTextFile(cwd, ".config/settings.json", "{}");
        yield* writeTextFile(cwd, "config/settings.json", "{}");

        const directoryResult = yield* workspaceEntries.browse({
          partialPath: appendSeparator(cwd),
        });
        const hiddenPrefixResult = yield* workspaceEntries.browse({
          partialPath: `${appendSeparator(cwd)}.c`,
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
        const workspaceEntries = yield* WorkspaceEntries;
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
        const workspaceEntries = yield* WorkspaceEntries;

        const error = yield* workspaceEntries
          .browse({
            partialPath: "./src",
          })
          .pipe(Effect.flip);

        expect(error.detail).toBe("Relative filesystem browse paths require a current project.");
      }),
    );
  });
});
