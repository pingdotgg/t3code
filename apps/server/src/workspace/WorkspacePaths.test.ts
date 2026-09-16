import * as NodeServices from "@effect/platform-node/NodeServices";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
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

const runGit = Effect.fn("WorkspacePaths.test.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  return yield* vcsProcess.run({
    operation: "WorkspacePaths.test.git",
    command: "git",
    cwd,
    args,
    timeoutMs: 5_000,
  });
});

const makeBareRoot = Effect.fn("WorkspacePaths.test.makeBareRoot")(function* () {
  const root = yield* makeTempDir();
  yield* runGit(root, ["init", "--bare", "--initial-branch=main", ".bare"]);
  yield* writeTextFile(root, ".git", "gitdir: ./.bare\n");
  return root;
});

it.layer(TestLayer)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(cwd);
      }),
    );

    it.effect("rejects a bare repository root that only holds worktrees", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const root = yield* makeBareRoot();
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "develop", "develop"]);

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout), Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootBareRepositoryLayoutError);
      }),
    );

    it.effect("accepts a bare repository root when the caller does not check the layout", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const root = yield* makeBareRoot();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(root);

        expect(resolved).toBe(root);
      }),
    );

    it.effect("accepts a worktree of a bare repository root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const path = yield* Path.Path;
        const root = yield* makeBareRoot();
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "develop", "develop"]);
        const worktree = path.join(root, "develop");

        const resolved = yield* workspacePaths
          .normalizeWorkspaceRoot(worktree)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));

        expect(resolved).toBe(worktree);
      }),
    );

    it.effect("accepts an ordinary repository and a linked worktree", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const path = yield* Path.Path;
        const parent = yield* makeTempDir();
        const ordinary = path.join(parent, "ordinary");
        yield* runGit(parent, ["init", "--initial-branch=main", ordinary]);
        const linked = path.join(parent, "feature");
        yield* runGit(ordinary, ["worktree", "add", "--orphan", "-b", "feature", linked]);

        const resolvedOrdinary = yield* workspacePaths
          .normalizeWorkspaceRoot(ordinary)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));
        const resolvedLinked = yield* workspacePaths
          .normalizeWorkspaceRoot(linked)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));

        expect(resolvedOrdinary).toBe(ordinary);
        expect(resolvedLinked).toBe(linked);
      }),
    );

    it.effect("rejects a bare repository root before any worktree is added", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const root = yield* makeBareRoot();

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout), Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootBareRepositoryLayoutError);
      }),
    );

    it.effect("accepts a freshly initialized separate git directory inside the root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        yield* runGit(root, ["init", "--separate-git-dir", path.join(root, "store")]);

        const resolved = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));

        expect(resolved).toBe(root);
      }),
    );

    it.effect("accepts a separate git directory inside a root that stages work", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        yield* runGit(root, ["init", "--separate-git-dir", path.join(root, "store")]);
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "feature", "feature"]);
        yield* writeTextFile(root, "README.md", "staged checkout\n");
        yield* runGit(root, ["add", "README.md"]);

        const resolved = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));

        expect(resolved).toBe(root);
      }),
    );

    it.effect("accepts a root whose git file points at the root itself", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        yield* writeTextFile(root, ".git", `gitdir: ${path.join(root, ".")}\n`);

        const resolved = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.flatMap(workspacePaths.ensureNotBareRepositoryLayout));

        expect(resolved).toBe(root);
      }),
    );

    it.effect("accepts an unborn separate-git-dir checkout with an orphan linked worktree", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        yield* runGit(root, ["init", "--separate-git-dir", path.join(root, "store")]);
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "feature", "feature"]);
        expect(yield* fileSystem.exists(path.join(root, "store", "index"))).toBe(false);
        expect((yield* runGit(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
          "true",
        );

        expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
      }),
    );

    it.effect("rejects a still-bare root even when Git has created an index", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeBareRoot();
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "feature", "feature"]);
        yield* runGit(root, ["--git-dir", path.join(root, ".bare"), "read-tree", "--empty"]);
        expect(yield* fileSystem.exists(path.join(root, ".bare", "index"))).toBe(true);
        expect((yield* runGit(root, ["rev-parse", "--is-bare-repository"])).stdout.trim()).toBe(
          "true",
        );

        const error = yield* workspacePaths.ensureNotBareRepositoryLayout(root).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootBareRepositoryLayoutError);
      }),
    );

    it.effect("leaves a root already converted to a nonbare repository accepted", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const root = yield* makeBareRoot();
        yield* runGit(root, ["worktree", "add", "--orphan", "-b", "feature", "feature"]);
        yield* runGit(root, ["init"]);
        expect((yield* runGit(root, ["rev-parse", "--is-bare-repository"])).stdout.trim()).toBe(
          "false",
        );

        expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
      }),
    );

    it.effect("accepts an unresolved git directory when the Git query exits nonzero", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const root = yield* makeTempDir();
        yield* writeTextFile(root, ".git", "gitdir: ./missing-git-directory\n");

        expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
      }),
    );

    it.effect("lets Git reject malformed gitfiles instead of probing an unrelated target", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const vcsProcess = yield* VcsProcess.VcsProcess;
        const root = yield* makeBareRoot();
        for (const pointer of ["metadata\ngitdir: .bare\n", "gitdir:.bare\n", " gitdir: .bare\n"]) {
          yield* writeTextFile(root, ".git", pointer);
          const native = yield* vcsProcess.run({
            operation: "WorkspacePaths.test.malformedGitfile",
            command: "git",
            cwd: root,
            args: ["rev-parse", "--is-bare-repository"],
            allowNonZeroExit: true,
          });
          expect(native.exitCode).not.toBe(0);
          expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
        }
      }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "preserves trailing spaces in POSIX gitdir names",
      () =>
        Effect.gen(function* () {
          const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
          const path = yield* Path.Path;
          const root = yield* makeTempDir();
          yield* runGit(root, ["init", "--separate-git-dir", path.join(root, "store ")]);
          yield* runGit(root, ["init", "--bare", path.join(root, "store")]);
          expect((yield* runGit(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
            "true",
          );

          expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
        }),
    );

    it.effect(
      "classifies the root independently of inherited Git worktree and gitdir overrides",
      () =>
        Effect.gen(function* () {
          const vcsProcess = yield* VcsProcess.VcsProcess;
          const path = yield* Path.Path;
          const root = yield* makeBareRoot();
          const otherRoot = yield* makeTempDir();
          yield* runGit(otherRoot, ["init"]);
          for (const inheritedEnv of [
            { GIT_WORK_TREE: root },
            { GIT_DIR: path.join(otherRoot, ".git") },
          ]) {
            const native = yield* vcsProcess.run({
              operation: "WorkspacePaths.test.inheritedGitEnvironment",
              command: "git",
              cwd: root,
              args: ["rev-parse", "--is-bare-repository"],
              env: inheritedEnv,
            });
            expect(native.stdout.trim()).toBe("false");
            const workspacePaths = yield* WorkspacePaths.make.pipe(
              Effect.provideService(VcsProcess.VcsProcess, {
                run: (input) =>
                  vcsProcess.run({ ...input, env: { ...inheritedEnv, ...input.env } }),
              }),
            );

            const error = yield* workspacePaths
              .ensureNotBareRepositoryLayout(root)
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootBareRepositoryLayoutError);
          }
        }),
    );

    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      "preserves literal backslashes in POSIX gitdir names",
      () =>
        Effect.gen(function* () {
          const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
          const path = yield* Path.Path;
          const root = yield* makeTempDir();
          const gitDir = path.join(root, "store\\name");
          yield* runGit(root, ["init", "--separate-git-dir", gitDir]);
          yield* runGit(root, ["init", "--bare", path.join(root, "store", "name")]);
          expect((yield* runGit(root, ["rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe(
            "true",
          );

          expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
        }),
    );

    it.effect("accepts the root when Git cannot be started", () =>
      Effect.gen(function* () {
        const root = yield* makeBareRoot();
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: (input) =>
              Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  cause: new Error("Git is unavailable in this fixture"),
                }),
              ),
          }),
        );

        expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
      }),
    );

    it.effect("does not run Git for ordinary roots or pointers outside or equal to the root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* makeTempDir();
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(VcsProcess.VcsProcess, {
            run: () => Effect.die("The fast path must not start Git"),
          }),
        );
        for (const [name, pointer] of [
          ["plain", undefined],
          ["outside", "gitdir: ../shared.git\n"],
          ["self", "gitdir: .\n"],
          ["malformed", "not a gitdir pointer\n"],
        ] as const) {
          const root = path.join(parent, name);
          yield* fileSystem.makeDirectory(root);
          if (pointer !== undefined) yield* writeTextFile(root, ".git", pointer);
          expect(yield* workspacePaths.ensureNotBareRepositoryLayout(root)).toBe(root);
        }
        const ordinary = path.join(parent, "ordinary");
        yield* runGit(parent, ["init", ordinary]);
        expect(yield* workspacePaths.ensureNotBareRepositoryLayout(ordinary)).toBe(ordinary);
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(missingPath);
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );

    it.effect("preserves non-NotFound stat failures while validating the root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: "Test PermissionDenied stat failure.",
                }),
              ),
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./permission-denied ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "validate-existing",
        });
      }),
    );

    it.effect("preserves stat failures while verifying a newly created root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let statCalls = 0;
        const workspacePaths = yield* WorkspacePaths.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            stat: (path) => {
              statCalls += 1;
              const reason = statCalls === 1 ? "NotFound" : "PermissionDenied";
              return Effect.fail(
                PlatformError.systemError({
                  _tag: reason,
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: String(path),
                  description: `Test ${reason} stat failure.`,
                }),
              );
            },
            makeDirectory: () => Effect.void,
          }),
        );
        const path = yield* Path.Path;
        const workspaceRoot = " ./created-then-unreadable ";
        const normalizedWorkspaceRoot = path.resolve(workspaceRoot.trim());

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(workspaceRoot, { createIfMissing: true })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspaceRootStatFailedError);
        expect(error).toMatchObject({
          workspaceRoot,
          normalizedWorkspaceRoot,
          phase: "verify-created",
        });
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});
