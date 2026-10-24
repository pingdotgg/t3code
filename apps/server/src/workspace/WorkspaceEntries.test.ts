// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type ProjectListIgnoredFilesResult,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const layerTest = Layer.empty.pipe(
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

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

const appendSeparator = (input: string) =>
  Effect.map(HostProcess.Platform, (platform) =>
    input.endsWith("/") || input.endsWith("\\")
      ? input
      : `${input}${platform === "win32" ? "\\" : "/"}`,
  );

it.layer(layerTest, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("lists immediate children including ignored and empty directories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "tracked.txt");
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env\ntracked.txt\n");
        yield* writeTextFile(cwd, ".env", "secret=value");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* fileSystem.makeDirectory(path.join(cwd, "empty"));

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const root = yield* workspaceEntries.list({ cwd, directoryPath: "" });
        expect(root.entries).toEqual(
          expect.arrayContaining([
            { path: ".env", kind: "file", ignored: true },
            { path: "node_modules", kind: "directory", ignored: true },
            { path: "src", kind: "directory" },
            { path: "empty", kind: "directory" },
            { path: "tracked.txt", kind: "file" },
          ]),
        );
        expect(root.entries.some((entry) => entry.path.includes("/"))).toBe(false);
        expect(root.entries.some((entry) => entry.path === ".git")).toBe(false);
        expect(root.truncated).toBe(false);
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "node_modules/pkg" })).toEqual({
          entries: [{ path: "node_modules/pkg/index.js", kind: "file", ignored: true }],
          truncated: false,
        });
        expect(yield* workspaceEntries.list({ cwd, directoryPath: "empty" })).toEqual({
          entries: [],
          truncated: false,
        });
      }),
    );

    it.effect("labels the children of wide folders exactly as git does for each child", () =>
      Effect.gen(function* () {
        // Above 1,000 children, listing first asks whether the whole folder is ignored.
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        yield* writeTextFile(
          cwd,
          ".gitignore",
          "node_modules/\ndist/\n\\[id\\]/\n*.map\nfoo\n!foo/\n",
        );
        yield* Effect.forEach(
          [
            "node_modules",
            "dist",
            "[id]",
            "src",
            ...(platform !== "win32" ? [":foo"] : []),
          ].flatMap((directory) =>
            Array.from({ length: 1001 }, (_, index) => `${directory}/pkg-${index}.js`),
          ),
          (relativePath) => writeTextFile(cwd, relativePath),
          { concurrency: 32, discard: true },
        );
        for (const relativePath of [
          "dist/kept.js",
          "dist/vendored/index.js",
          "i/page.tsx",
          "[id]/page.tsx",
          "src/bundle.map",
        ]) {
          yield* writeTextFile(cwd, relativePath);
        }
        yield* git(cwd, ["add", "-f", "dist/kept.js", "dist/vendored/index.js", "i/page.tsx"]);
        if (platform !== "win32") {
          yield* fileSystem.symlink(path.join(cwd, "src"), path.join(cwd, "node_modules/link"));
        }

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const { directoryPath, ignored, except } of [
          { directoryPath: "node_modules", ignored: true, except: [] },
          // A force-tracked file and a folder holding tracked files stay unignored.
          { directoryPath: "dist", ignored: true, except: ["dist/kept.js", "dist/vendored"] },
          // git reads `[id]/page.tsx` as a pathspec, which matches the tracked `i/page.tsx`.
          { directoryPath: "[id]", ignored: true, except: ["[id]/page.tsx"] },
          { directoryPath: "src", ignored: false, except: ["src/bundle.map"] },
          ...(platform !== "win32"
            ? [
                // git refuses to classify paths beyond a symlink, so nothing there is labelled.
                { directoryPath: "node_modules/link", ignored: false, except: [] },
                // A leading `:` is pathspec magic, so git reads `:foo/pkg-0.js` as `foo/pkg-0.js`,
                // which `!foo/` keeps unignored.
                { directoryPath: ":foo", ignored: false, except: [] },
              ]
            : []),
        ]) {
          const { entries } = yield* workspaceEntries.list({ cwd, directoryPath });
          expect(entries.length, directoryPath).toBeGreaterThan(1000);
          expect(
            entries
              .filter((entry) => (entry.ignored === true) !== ignored)
              .map((entry) => entry.path)
              .toSorted(),
            directoryPath,
          ).toEqual(except);
        }
      }),
    );

    it.effect("lists a host folder and its parent, each from its own root", () =>
      // Folder links outside the workspace browse by passing the host folder as
      // `cwd`; walking up passes the parent. Each stays bounded by its own root.
      Effect.gen(function* () {
        const parent = yield* makeTempDir();
        const path = yield* Path.Path;
        yield* writeTextFile(parent, "linked/notes.md");
        yield* writeTextFile(parent, "sibling/readme.md");
        const linked = path.join(parent, "linked");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.list({ cwd: linked, directoryPath: "" })).toEqual({
          entries: [{ path: "notes.md", kind: "file" }],
          truncated: false,
        });
        const up = yield* workspaceEntries.list({ cwd: parent, directoryPath: "" });
        expect(up.entries.map((entry) => entry.path).toSorted()).toEqual(["linked", "sibling"]);
        const escape = yield* workspaceEntries
          .list({ cwd: linked, directoryPath: "../sibling" })
          .pipe(Effect.flip);
        expect(escape._tag).toBe("WorkspaceEntriesReadDirectoryError");
      }),
    );

    it.effect(
      "rejects directory traversal, git internals, and symlinks outside the workspace",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTempDir();
          const outside = yield* makeTempDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* writeTextFile(cwd, ".git/HEAD");
          const platform = yield* HostProcess.Platform;
          if (platform !== "win32") yield* fileSystem.symlink(outside, path.join(cwd, "external"));
          const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
          for (const directoryPath of [
            "../",
            outside,
            ".git",
            "missing",
            ...(platform !== "win32" ? ["external"] : []),
          ]) {
            const error = yield* workspaceEntries.list({ cwd, directoryPath }).pipe(Effect.flip);
            expect(error._tag).toBe("WorkspaceEntriesReadDirectoryError");
          }
        }),
    );

    it.effect("includes images and other binary files in non-git workspace indexes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const imagePaths = ["photo.png", "photo.jpg", "photo.jpeg"];
        const binaryPaths = [...imagePaths, "document.pdf", "archive.zip", "data.bin"];
        for (const filePath of binaryPaths) {
          yield* writeTextFile(cwd, filePath, "\0binary contents\n");
        }
        yield* writeTextFile(cwd, "notes.txt", "plain text\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const expectedPaths = [...binaryPaths, "notes.txt"].toSorted();
        const listed = yield* workspaceEntries.list({ cwd });
        expect(listed.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(listed.truncated).toBe(false);

        const searched = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          kind: "file",
        });
        expect(searched.entries.map((entry) => entry.path).toSorted()).toEqual(expectedPaths);
        expect(searched.truncated).toBe(false);

        const images = yield* workspaceEntries.search({
          cwd,
          query: "",
          limit: 100,
          imageOnly: true,
        });
        expect(images.entries.map((entry) => entry.path).toSorted()).toEqual(imagePaths.toSorted());
        expect(images.truncated).toBe(false);
      }),
    );
  });

  describe("listIgnoredFiles", () => {
    it.effect("browses every captured ignored path in bounded pages without duplicates", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeTextFile(cwd, ".gitignore", "*.log\n.env*\nnode_modules/\n");
        yield* writeTextFile(cwd, ".agents/keep.txt", "tracked");
        yield* writeTextFile(cwd, "services/api/index.ts", "tracked");
        yield* git(cwd, ["add", ".agents/keep.txt", "services/api/index.ts"]);
        const logs = Array.from(
          { length: 605 },
          (_, i) => `.agents/run-${String(i).padStart(4, "0")}.log`,
        );
        yield* Effect.forEach(logs, (name) => writeTextFile(cwd, name, "x"));
        yield* writeTextFile(cwd, "services/api/.env.local", "A=1");
        yield* writeTextFile(cwd, "node_modules/excluded.log", "excluded");

        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const seen: string[] = [];
        let after: string | undefined;
        let pageCount = 0;
        do {
          const page: ProjectListIgnoredFilesResult = yield* entries.listIgnoredFiles({
            cwd,
            ...(after ? { after } : {}),
          });
          expect(page.files.length).toBeLessThanOrEqual(200);
          expect(page.truncated).toBe(page.nextCursor !== undefined);
          expect(page.outputTruncated).not.toBe(true);
          if (pageCount === 0) {
            expect(page.files[0]).toEqual({ path: "services/api/.env.local", byteLength: 3 });
            expect(page.nextCursor).toBe(".agents/run-0198.log");
            yield* fileSystem.remove(`${cwd}/.agents/run-0198.log`);
          }
          seen.push(...page.files.map((file) => file.path));
          after = page.nextCursor;
          pageCount++;
          expect(pageCount).toBeLessThanOrEqual(4);
        } while (after !== undefined);
        expect(pageCount).toBe(4);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.toSorted()).toEqual(["services/api/.env.local", ...logs].toSorted());

        const matches: string[] = [];
        after = undefined;
        let filteredPages = 0;
        do {
          const page: ProjectListIgnoredFilesResult = yield* entries.listIgnoredFiles({
            cwd,
            query: "  .AGENTS/RUN-0  ",
            ...(after ? { after } : {}),
          });
          expect(page.files.length).toBeLessThanOrEqual(200);
          matches.push(...page.files.map((file) => file.path));
          after = page.nextCursor;
          filteredPages++;
          expect(filteredPages).toBeLessThanOrEqual(4);
        } while (after !== undefined);
        expect(filteredPages).toBe(4);
        expect(new Set(matches).size).toBe(matches.length);
        expect(matches).toEqual(logs.filter((name) => name !== ".agents/run-0198.log"));
      }),
    );

    it.effect("advances past an empty candidate page and a removed or symlink cursor", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const missing = Array.from({ length: 199 }, (_, i) => `a-${String(i).padStart(3, "0")}`);
        yield* writeTextFile(cwd, "z-file", "last");
        yield* fileSystem.symlink(`${cwd}/z-file`, `${cwd}/a-link`);
        const entries = yield* WorkspaceEntries.make.pipe(
          Effect.provideService(
            VcsProcess.VcsProcess,
            VcsProcess.VcsProcess.of({
              run: () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: [...missing, "a-link", "z-file"].join("\0") + "\0",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
            }),
          ),
          Effect.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
        );
        const first = yield* entries.listIgnoredFiles({ cwd });
        expect(first).toEqual({ files: [], truncated: true, nextCursor: "a-link" });
        yield* fileSystem.remove(`${cwd}/a-link`);
        expect(yield* entries.listIgnoredFiles({ cwd, after: first.nextCursor })).toEqual({
          files: [{ path: "z-file", byteLength: 4 }],
          truncated: false,
        });
      }),
    );

    it.effect("drops only the incomplete trailing record when Git output is truncated", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, ".env", "A=1");
        yield* writeTextFile(cwd, "partial", "must not be listed");
        for (const stdout of [".env\0partial", ".env\0"]) {
          const entries = yield* WorkspaceEntries.make.pipe(
            Effect.provideService(
              VcsProcess.VcsProcess,
              VcsProcess.VcsProcess.of({
                run: () =>
                  Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout,
                    stderr: "",
                    stdoutTruncated: true,
                    stderrTruncated: false,
                  }),
              }),
            ),
            Effect.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
          );
          expect(yield* entries.listIgnoredFiles({ cwd })).toEqual({
            files: [{ path: ".env", byteLength: 3 }],
            truncated: false,
            outputTruncated: true,
          });
        }
      }),
    );

    it.effect("preserves Git timeout and spawn failures as typed listing errors", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const context = { cwd, command: "git", operation: "WorkspaceEntries.listIgnoredFiles" };
        for (const cause of [
          new VcsProcessSpawnError({ ...context, cause: new Error("git unavailable") }),
          new VcsProcessTimeoutError({ ...context, timeoutMs: 10_000 }),
        ]) {
          const entries = yield* WorkspaceEntries.make.pipe(
            Effect.provideService(
              VcsProcess.VcsProcess,
              VcsProcess.VcsProcess.of({
                run: () => Effect.fail(cause),
              }),
            ),
            Effect.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
          );
          const error = yield* entries.listIgnoredFiles({ cwd }).pipe(Effect.flip);
          expect(error).toMatchObject({ _tag: "WorkspaceEntriesListIgnoredFilesError", cause });
        }
      }),
    );

    it.effect("returns a typed failure when Git exits unsuccessfully", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const error = yield* entries.listIgnoredFiles({ cwd }).pipe(Effect.flip);
        expect(error._tag).toBe("WorkspaceEntriesListIgnoredFilesError");
        if (error._tag === "WorkspaceEntriesListIgnoredFilesError") {
          expect(error.cause).toMatchObject({ _tag: "VcsProcessExitError" });
        }
      }),
    );

    it.effect("searches all ignored paths before limiting results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "*.log\nnode_modules/\n");
        yield* writeTextFile(cwd, "data/keep.txt", "tracked");
        yield* git(cwd, ["add", "data/keep.txt"]);
        yield* Effect.forEach(
          Array.from({ length: 205 }, (_, i) => i),
          (i) => writeTextFile(cwd, `data/generated-${String(i).padStart(3, "0")}.log`, "x"),
        );
        yield* writeTextFile(cwd, "data/z-Target.log", "found");
        yield* writeTextFile(cwd, "node_modules/z-target.log", "excluded");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(
          yield* workspaceEntries.listIgnoredFiles({ cwd, query: "  DaTa/Z-TaRgEt.LoG  " }),
        ).toEqual({
          files: [{ path: "data/z-Target.log", byteLength: 5 }],
          truncated: false,
        });
        const unfiltered = yield* workspaceEntries.listIgnoredFiles({ cwd });
        expect(unfiltered.files.map((file) => file.path)).not.toContain("data/z-Target.log");
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd, query: "" })).toEqual(unfiltered);
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd, query: "   " })).toEqual(unfiltered);
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd, query: "node_modules" })).toEqual({
          files: [],
          truncated: false,
        });
      }),
    );

    it.effect("lists ignored files with sizes and skips wholly ignored folders", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", "node_modules/\n.env*\n");
        yield* writeTextFile(cwd, ".env", "A=1");
        yield* writeTextFile(cwd, "apps/web/index.ts", "y");
        yield* git(cwd, ["add", "apps/web/index.ts"]);
        yield* writeTextFile(cwd, "apps/web/.env.local", "B=22");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "x");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        expect(yield* workspaceEntries.listIgnoredFiles({ cwd })).toEqual({
          files: [
            { path: ".env", byteLength: 3 },
            { path: "apps/web/.env.local", byteLength: 4 },
          ],
          truncated: false,
        });
      }),
    );
  });

  describe("search", () => {
    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        // Native ranking can put either matching file first.
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.kind).toBe("file");
        expect(["src/index.ts", "src/internal.ts"]).toContain(result.entries[0]?.path);
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

    it.effect("finds later whole-word matches in a file after rejected raw matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-late-whole-word-" });
        yield* writeTextFile(cwd, "src/words.ts", `${"afoo\n".repeat(10)}foo\n`);

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 1,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 11,
            matchRanges: [{ start: 0, end: 3 }],
          }),
        ]);
      }),
    );

    it.effect("treats astral-plane letters as whole word characters", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-astral-word-" });
        yield* writeTextFile(cwd, "src/words.ts", "𐐀foo foo foo𐐀\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "foo",
          limit: 100,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        });

        expect(result.matches).toEqual([
          expect.objectContaining({
            path: "src/words.ts",
            lineNumber: 1,
            matchRanges: [{ start: 6, end: 9 }],
          }),
        ]);
      }),
    );

    it.effect("matches punctuation-edged whole-word queries including adjacent occurrences", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-punctuation-" });
        yield* writeTextFile(cwd, "src/words.ts", "-foo- -foo- -foo-\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "-foo-",
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
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 12, end: 17 },
          ],
        });
      }),
    );

    it.effect("caps matches per file so one dense file cannot fill the page", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-per-file-cap-" });
        yield* writeTextFile(cwd, "src/dense.ts", "needle\n".repeat(300));
        yield* writeTextFile(cwd, "src/other.ts", "needle\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "needle",
          limit: 500,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        const byPath = new Map<string, number>();
        for (const match of result.matches) {
          byPath.set(match.path, (byPath.get(match.path) ?? 0) + 1);
        }
        expect(byPath.get("src/dense.ts")).toBe(100);
        expect(byPath.get("src/other.ts")).toBe(1);
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

    it.effect("maps multi-byte lines to string-indexed ranges", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-content-multibyte-" });
        yield* writeTextFile(cwd, "src/notes.ts", 'const label = "héllo wörld";\n');

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.searchContents({
          cwd,
          query: "wörld",
          limit: 100,
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toHaveLength(1);
        const match = result.matches[0]!;
        const range = match.matchRanges[0]!;
        expect(match.lineContent.slice(range.start, range.end)).toBe("wörld");
      }),
    );
  });

  describe("browse", () => {
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
  });
});
