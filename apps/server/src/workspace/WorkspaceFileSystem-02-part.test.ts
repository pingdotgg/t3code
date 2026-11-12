// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO, and reads spy on native realpath.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});

const injectShortReads = Effect.fn("injectShortReads")(function* (target: string) {
  const native = yield* Effect.promise(() => vi.importActual<typeof NodeFSP>("node:fs/promises"));
  const open = vi.mocked(NodeFSP.open).mockImplementation(async (path, flags, mode) => {
    const handle = await native.open(path, flags, mode);
    if (path === target) {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: (buffer: Uint8Array, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 2), position),
      });
    }
    return handle;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => open.mockImplementation(native.open)));
});

const UNKNOWN_WORKSPACE_PREFIX = "t3code-unknown-workspace-";
const layerKnownWorkspacesTest = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: (cwd) =>
    cwd.includes(UNKNOWN_WORKSPACE_PREFIX)
      ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
      : Effect.void,
});

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(layerKnownWorkspacesTest),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});



it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("rejects writes outside a known workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: UNKNOWN_WORKSPACE_PREFIX,
        });

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "plan.md", contents: "# nope\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
        expect(yield* fileSystem.readDirectory(cwd)).toEqual([]);
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("saves over an existing file without rescanning the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export {};\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "src/main.ts",
          contents: "export const edited = true;\n",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "src/main.ts"))).toBe(
          "export const edited = true;\n",
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(WorkspaceFileSystem.layer).pipe(
            Layer.provide(layerKnownWorkspacesTest),
            Layer.provide(WorkspacePaths.layer),
            Layer.provide(
              Layer.mock(WorkspaceEntries.WorkspaceEntries)({
                refresh: () => Effect.die("An overwrite rescanned the workspace."),
              }),
            ),
          ),
        ),
      ),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects writes through symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "existing.md", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          yield* fileSystem.symlink(
            path.join(outsideDir, "existing.md"),
            path.join(cwd, "linked-file.md"),
          );
          yield* fileSystem.symlink(
            path.join(outsideDir, "missing.md"),
            path.join(cwd, "dangling.md"),
          );

          for (const relativePath of [
            "linked-dir/new.md",
            "linked-dir/nested/new.md",
            "linked-file.md",
          ]) {
            const error = yield* workspaceFileSystem
              .writeFile({ cwd, relativePath, contents: "# nope\n" })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          }
          const danglingError = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(danglingError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFileSystemOperationError,
          );
          expect(danglingError).toMatchObject({ operation: "realpath-target" });

          expect((yield* fileSystem.readDirectory(outsideDir)).toSorted()).toEqual(["existing.md"]);
          expect(yield* fileSystem.readFileString(path.join(outsideDir, "existing.md"))).toBe(
            "outside\n",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through symlinks that stay inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* makeTempDir;
          const cwd = path.join(parentDir, "workspace");
          const cwdAlias = path.join(parentDir, "workspace-alias");
          yield* writeTextFile(cwd, "docs/README.md", "old\n");
          yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
          yield* fileSystem.symlink("docs/README.md", path.join(cwd, "README.md"));
          yield* fileSystem.symlink(cwd, cwdAlias);

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "docs-alias/plans/plan.md",
            contents: "# Plan\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "README.md",
            contents: "new\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: cwdAlias,
            relativePath: "notes.md",
            contents: "notes\n",
          });
          // `..` after a link in cwd is resolved by name, as for the relative path.
          yield* fileSystem.symlink(path.join(cwd, "docs/plans"), path.join(cwd, "plans-alias"));
          yield* workspaceFileSystem.writeFile({
            cwd: `${path.join(cwd, "plans-alias")}${path.sep}..`,
            relativePath: "dotdot.md",
            contents: "dotdot\n",
          });

          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/plans/plan.md"))).toBe(
            "# Plan\n",
          );
          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/README.md"))).toBe("new\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "README.md"))).toBe("docs/README.md");
          expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("notes\n");
          expect(yield* fileSystem.readFileString(path.join(cwd, "dotdot.md"))).toBe("dotdot\n");
        }),
    );

    // On Windows `\` is a separator, so the name cannot exist there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps a backslash in a file name as part of the name",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "a\\b.md", "old\n");

          yield* workspaceFileSystem.writeFile({ cwd, relativePath: "a\\b.md", contents: "new\n" });

          expect(
            (yield* workspaceFileSystem.readFile({ cwd, relativePath: "a\\b.md" })).contents,
          ).toBe("new\n");
          expect(yield* fileSystem.readDirectory(cwd)).toEqual(["a\\b.md"]);
        }),
    );

    it.effect("refuses writes into git's own folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/config", "[core]\n");
        yield* writeTextFile(cwd, ".bare/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/objects/info/packs");
        yield* writeTextFile(cwd, ".bare/refs/heads/main");
        yield* writeTextFile(cwd, ".bare/hooks/pre-push.sample");
        // Only a linked worktree's `.git` file ends the upward check, not any `.git` folder.
        yield* fileSystem.makeDirectory(path.join(cwd, ".bare/hooks/.git"));
        yield* writeTextFile(cwd, ".bare/worktrees/main/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/worktrees/main/commondir", "../..\n");
        if (symlinksSupported) yield* fileSystem.symlink(".git", path.join(cwd, "docs"));

        for (const [folder, relativePath] of [
          [cwd, ".git/config"],
          [cwd, ".git/hooks/pre-commit"],
          [cwd, "sub/.git"],
          [cwd, ".GIT/config"],
          [cwd, ".gıt/config"],
          [cwd, ".git. /config"],
          [cwd, ".git::$INDEX_ALLOCATION/config"],
          [cwd, "GIT~1/config"],
          [path.join(cwd, ".git"), "config"],
          [cwd, ".bare/config"],
          [path.join(cwd, ".bare"), "hooks/post-checkout"],
          [path.join(cwd, ".bare/hooks"), "post-checkout"],
          [path.join(cwd, ".bare/worktrees/main"), "commondir"],
          ...(symlinksSupported ? [[cwd, "docs/config"] as const] : []),
        ] as const) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd: folder, relativePath, contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        }

        expect(yield* fileSystem.readFileString(path.join(cwd, ".git/config"))).toBe("[core]\n");
        expect(yield* fileSystem.exists(path.join(cwd, ".bare/config"))).toBe(false);
        expect((yield* fileSystem.readDirectory(path.join(cwd, ".bare/hooks"))).toSorted()).toEqual(
          [".git", "pre-push.sample"],
        );
        expect(yield* fileSystem.exists(path.join(cwd, "sub"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".bare/worktrees/main/commondir")),
        ).toBe("../..\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses writes through a git config that links to a file outside git's folders",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "shared/config", "[core]\n");
          yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
          yield* fileSystem.symlink("../shared/config", path.join(cwd, ".git/config"));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: ".git/config", contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fileSystem.readFileString(path.join(cwd, "shared/config"))).toBe(
            "[core]\n",
          );
        }),
    );

    it.effect("writes files that sit beside git's folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* makeTempDir;
        const bare = path.join(parentDir, "repo.git");
        yield* writeTextFile(bare, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(bare, "objects/info/packs");
        yield* writeTextFile(bare, "refs/heads/main");
        yield* writeTextFile(bare, "main/.git", `gitdir: ${path.join(bare, "worktrees/main")}\n`);

        for (const [cwd, relativePath] of [
          [path.join(bare, "main"), ".gitignore"],
          [path.join(bare, "main"), ".gitattributes"],
          [path.join(bare, "main"), ".github/workflows/ci.yml"],
          [path.join(bare, "main"), "vendor/lib.git/README.md"],
          [path.join(bare, "main/.github"), "CODEOWNERS"],
          [bare, "main/plan.md"],
        ] as const) {
          yield* workspaceFileSystem.writeFile({ cwd, relativePath, contents: "ok\n" });
          expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("ok\n");
        }
      }),
    );
  });
});

