import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type ClientFileRoot,
  type VerifiedClientFileRoot,
  readAntigravityClientTextFile,
  resolveGitWorktreeDirectory,
} from "./AntigravityClientFiles.ts";

const runGit = Effect.fn("AntigravityClientFilesTest.runGit")(function* (...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(ChildProcess.make("git", args));
  assert.equal(Number(code), 0, `git ${args.join(" ")}`);
});

const makeRepoWithWorktrees = Effect.fn("AntigravityClientFilesTest.makeRepoWithWorktrees")(
  function* (root: string, ...names: Array<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = path.join(root, "repo");
    yield* runGit("init", "-qb", "main", repo);
    yield* runGit(
      "-C",
      repo,
      "-c",
      "user.name=T3",
      "-c",
      "user.email=t3@example.org",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Initial commit",
    );
    const worktrees: Array<{ readonly path: string; readonly gitDir: string }> = [];
    for (const name of names) {
      const worktree = path.join(root, name);
      yield* runGit("-C", repo, "worktree", "add", "-qb", name, worktree);
      worktrees.push({
        path: worktree,
        gitDir: yield* fileSystem.realPath(path.join(repo, ".git", "worktrees", name)),
      });
    }
    return { repo, worktrees };
  },
);

const rootsFor = Effect.fn("AntigravityClientFilesTest.rootsFor")(function* (
  fileSystem: FileSystem.FileSystem,
  cwd: string,
  attachments: string,
) {
  const path = yield* Path.Path;
  const worktreeGitDir = yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd });
  const roots: ReadonlyArray<ClientFileRoot> =
    worktreeGitDir === undefined ? [cwd, attachments] : [cwd, attachments, worktreeGitDir];
  return { worktreeGitDir, roots };
});

const readWith = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  allowedRoots: ReadonlyArray<ClientFileRoot>,
  target: string,
) =>
  readAntigravityClientTextFile({
    fileSystem,
    path,
    allowedRoots,
    request: { sessionId: "worktree", path: target },
  });

const assertOutside = Effect.fn("AntigravityClientFilesTest.assertOutside")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  allowedRoots: ReadonlyArray<ClientFileRoot>,
  target: string,
) {
  const error = yield* Effect.flip(readWith(fileSystem, path, allowedRoots, target));
  assert.match(error.message, /outside the session workspace/);
});

/** Run `swap` once, the first time `fire` sees `target`. */
const swapOnce = (target: string, swap: Effect.Effect<void, PlatformError.PlatformError>) => {
  const state = { fired: false };
  const fire = (candidate: string) =>
    Effect.suspend(() => {
      if (state.fired || candidate !== target) return Effect.void;
      state.fired = true;
      return Effect.orDie(swap);
    });
  return { state, fire };
};

/** Record every `readAlloc` size, running `beforeRead` with the opened path first. */
const recordReads = (
  fileSystem: FileSystem.FileSystem,
  beforeRead: (target: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const sizes: Array<number> = [];
  const recording: FileSystem.FileSystem = {
    ...fileSystem,
    open: (target, options) =>
      fileSystem.open(target, options).pipe(
        Effect.map(
          (file) =>
            new Proxy(file, {
              get: (file, key, receiver) =>
                key === "readAlloc"
                  ? (...args: Parameters<FileSystem.File["readAlloc"]>) => {
                      sizes.push(args[0]);
                      return beforeRead(target).pipe(Effect.andThen(file.readAlloc(...args)));
                    }
                  : Reflect.get(file, key, receiver),
            }),
        ),
      ),
  };
  return { sizes, recording };
};

it.layer(NodeServices.layer)("AntigravityClientFiles", (it) => {
  it.effect("reads a linked worktree HEAD from its root and subdirectories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const {
        repo,
        worktrees: [linked],
      } = yield* makeRepoWithWorktrees(root, "linked");
      const worktree = linked!.path;
      const gitDir = linked!.gitDir;
      const subdirectory = path.join(worktree, "apps", "web");
      const nestedRepo = path.join(worktree, "nested");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      yield* runGit("init", "-qb", "main", nestedRepo);
      yield* fileSystem.makeDirectory(subdirectory, { recursive: true });
      for (const cwd of [worktree, subdirectory]) {
        const { worktreeGitDir, roots } = yield* rootsFor(fileSystem, cwd, attachments);
        assert.equal(worktreeGitDir?.path, gitDir);
        const head = yield* readWith(fileSystem, path, roots, path.join(gitDir, "HEAD"));
        assert.equal(head.content, "ref: refs/heads/linked\n");
        yield* assertOutside(fileSystem, path, roots, path.join(repo, ".git", "config"));
      }

      const forged = path.join(worktree, "forged");
      yield* fileSystem.makeDirectory(forged);
      yield* fileSystem.symlink(path.join(worktree, ".git"), path.join(forged, ".git"));
      for (const boundary of [nestedRepo, forged]) {
        const cwd = path.join(boundary, "src");
        yield* fileSystem.makeDirectory(cwd);
        assert.isUndefined(yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd }));
      }
    }),
  );

  it.effect("keeps each checkout bound to its own worktree Git directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const {
        worktrees: [wtA, wtB],
      } = yield* makeRepoWithWorktrees(root, "wtA", "wtB");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      const headA = path.join(wtA!.gitDir, "HEAD");
      const symlinked = path.join(root, "symlinked");
      const hardlinked = path.join(root, "hardlinked");
      yield* fileSystem.makeDirectory(symlinked);
      yield* fileSystem.makeDirectory(hardlinked);
      yield* fileSystem.symlink(path.join(wtA!.path, ".git"), path.join(symlinked, ".git"));
      yield* fileSystem.link(path.join(wtA!.path, ".git"), path.join(hardlinked, ".git"));

      const { worktreeGitDir: fromB, roots: rootsB } = yield* rootsFor(
        fileSystem,
        wtB!.path,
        attachments,
      );
      assert.equal(fromB?.path, wtB!.gitDir);
      yield* assertOutside(fileSystem, path, rootsB, headA);
      for (const cwd of [symlinked, hardlinked]) {
        const { worktreeGitDir, roots } = yield* rootsFor(fileSystem, cwd, attachments);
        assert.isUndefined(worktreeGitDir, cwd);
        yield* assertOutside(fileSystem, path, roots, headA);
      }
    }),
  );

  it.effect.each(["after lstat", "after the pointer read"] as const)(
    "rejects a .git file swapped for a worktree's .git symlink %s",
    (timing) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const {
          worktrees: [linked],
        } = yield* makeRepoWithWorktrees(root, "linked");
        const forged = path.join(root, "forged");
        const forgedDotGit = path.join(forged, ".git");
        yield* fileSystem.makeDirectory(forged);
        yield* fileSystem.writeFileString(forgedDotGit, `gitdir: ${linked!.gitDir}\n`);
        const swap = swapOnce(
          forgedDotGit,
          fileSystem
            .remove(forgedDotGit)
            .pipe(
              Effect.andThen(fileSystem.symlink(path.join(linked!.path, ".git"), forgedDotGit)),
            ),
        );
        const racing: FileSystem.FileSystem =
          timing === "after lstat"
            ? {
                ...fileSystem,
                lstat: (target) =>
                  fileSystem.lstat(target).pipe(Effect.tap(() => swap.fire(target))),
              }
            : {
                ...fileSystem,
                realPath: (target) =>
                  swap.fire(target).pipe(Effect.andThen(fileSystem.realPath(target))),
              };
        assert.isUndefined(
          yield* resolveGitWorktreeDirectory({ fileSystem: racing, path, cwd: forged }),
        );
        assert.isTrue(swap.state.fired);
      }),
  );

  it.effect.each(["a symlink to the shared .git", "a new directory"] as const)(
    "stops serving a verified Git directory replaced by %s",
    (replacement) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped();
        const {
          repo,
          worktrees: [linked],
        } = yield* makeRepoWithWorktrees(root, "linked");
        const attachments = path.join(root, "attachments");
        yield* fileSystem.makeDirectory(attachments);
        const { worktreeGitDir, roots } = yield* rootsFor(fileSystem, linked!.path, attachments);
        const gitDir = worktreeGitDir!.path;
        const head = path.join(gitDir, "HEAD");
        assert.equal(
          (yield* readWith(fileSystem, path, roots, head)).content,
          "ref: refs/heads/linked\n",
        );

        yield* fileSystem.rename(gitDir, `${gitDir}.aside`);
        if (replacement === "a new directory") {
          yield* fileSystem.makeDirectory(gitDir);
          yield* fileSystem.writeFileString(head, "ref: refs/heads/replaced\n");
          yield* assertOutside(fileSystem, path, roots, head);
        } else {
          yield* fileSystem.symlink(path.join(repo, ".git"), gitDir);
          for (const target of [path.join(repo, ".git", "config"), path.join(gitDir, "config")]) {
            yield* assertOutside(fileSystem, path, roots, target);
          }
        }
      }),
  );

  it.effect("refuses a verified-root file swapped for a symlink before it is opened", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const {
        repo,
        worktrees: [linked],
      } = yield* makeRepoWithWorktrees(root, "linked");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      const { roots } = yield* rootsFor(fileSystem, linked!.path, attachments);
      const head = path.join(linked!.gitDir, "HEAD");
      const swap = swapOnce(
        head,
        fileSystem
          .remove(head)
          .pipe(Effect.andThen(fileSystem.symlink(path.join(repo, ".git", "config"), head))),
      );
      const racing: FileSystem.FileSystem = {
        ...fileSystem,
        realPath: (target) => fileSystem.realPath(target).pipe(Effect.tap(() => swap.fire(target))),
      };
      yield* assertOutside(racing, path, roots, head);
      assert.isTrue(swap.state.fired);
    }),
  );

  it.effect("sizes reads to the file and still caps files that grow while read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const {
        worktrees: [linked],
      } = yield* makeRepoWithWorktrees(root, "linked");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      const small = recordReads(fileSystem);
      const { roots } = yield* rootsFor(small.recording, linked!.path, attachments);
      const head = yield* readWith(small.recording, path, roots, path.join(linked!.gitDir, "HEAD"));
      assert.equal(head.content, "ref: refs/heads/linked\n");
      assert.isAbove(small.sizes.length, 0);
      assert.isTrue(
        small.sizes.every((size) => size <= 1024),
        `small reads: ${small.sizes}`,
      );

      const grown = path.join(linked!.path, "grown.txt");
      yield* fileSystem.writeFileString(grown, "small\n");
      const growth = swapOnce(
        grown,
        fileSystem.writeFileString(grown, "a".repeat(9 * 1024 * 1024)),
      );
      const growing = recordReads(fileSystem, growth.fire);
      const error = yield* Effect.flip(readWith(growing.recording, path, roots, grown));
      assert.isTrue(growth.state.fired);
      assert.match(error.message, /not a readable text file/);
      assert.isTrue(
        growing.sizes.every((size) => size <= 64 * 1024),
        `growing reads: ${Math.max(...growing.sizes)}`,
      );
    }),
  );

  it.effect("follows a workspace symlinked into a linked worktree subdirectory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const {
        repo,
        worktrees: [linked],
      } = yield* makeRepoWithWorktrees(root, "linked");
      const attachments = path.join(root, "attachments");
      yield* fileSystem.makeDirectory(attachments);
      const web = path.join(linked!.path, "apps", "web");
      const workspaceLink = path.join(root, "workspace-link");
      yield* fileSystem.makeDirectory(web, { recursive: true });
      yield* fileSystem.symlink(web, workspaceLink);
      const { worktreeGitDir, roots } = yield* rootsFor(fileSystem, workspaceLink, attachments);
      assert.equal(worktreeGitDir?.path, linked!.gitDir);
      const head = yield* readWith(fileSystem, path, roots, path.join(linked!.gitDir, "HEAD"));
      assert.equal(head.content, "ref: refs/heads/linked\n");
      yield* assertOutside(fileSystem, path, roots, path.join(repo, ".git", "config"));

      const forged = path.join(root, "forged");
      const forgedLink = path.join(root, "forged-link");
      yield* fileSystem.makeDirectory(path.join(forged, "src"), { recursive: true });
      yield* fileSystem.symlink(path.join(linked!.path, ".git"), path.join(forged, ".git"));
      yield* fileSystem.symlink(path.join(forged, "src"), forgedLink);
      assert.isUndefined(yield* resolveGitWorktreeDirectory({ fileSystem, path, cwd: forgedLink }));
    }),
  );

  // Windows drops trailing spaces from file names.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps trailing pathname spaces in the workspace, gitfile and commondir paths",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const {
          repo,
          worktrees: [linked],
        } = yield* makeRepoWithWorktrees(root, "linked");
        const attachments = path.join(root, "attachments");
        yield* fileSystem.makeDirectory(attachments);
        const checkout = path.join(root, "linked ");
        const subdirectory = path.join(checkout, "src ");
        yield* runGit("-C", repo, "worktree", "move", linked!.path, checkout);
        // Git keeps these spaces, but `worktree add` sanitizes ids, so rename into place.
        const commonDir = path.join(root, "common ");
        const gitDir = path.join(commonDir, "worktrees", "linked ");
        yield* fileSystem.rename(path.join(repo, ".git"), commonDir);
        yield* fileSystem.writeFileString(path.join(repo, ".git"), `gitdir: ${commonDir}\n`);
        yield* fileSystem.rename(path.join(commonDir, "worktrees", "linked"), gitDir);
        yield* fileSystem.writeFileString(path.join(checkout, ".git"), `gitdir: ${gitDir}\n`);
        yield* fileSystem.writeFileString(path.join(gitDir, "commondir"), `${commonDir}\n`);
        yield* fileSystem.makeDirectory(subdirectory);
        yield* runGit("-C", subdirectory, "rev-parse", "--verify", "HEAD");

        for (const cwd of [checkout, subdirectory]) {
          const { worktreeGitDir, roots } = yield* rootsFor(fileSystem, cwd, attachments);
          assert.equal(worktreeGitDir?.path, gitDir, cwd);
          const head = yield* readWith(fileSystem, path, roots, path.join(gitDir, "HEAD"));
          assert.equal(head.content, "ref: refs/heads/linked\n");
          yield* assertOutside(fileSystem, path, roots, path.join(commonDir, "config"));
        }
      }),
  );

  const syntheticBreaks = {
    "a normal .git directory": ({ fileSystem, dotGit }) =>
      fileSystem.remove(dotGit).pipe(Effect.andThen(fileSystem.makeDirectory(dotGit))),
    "a multiline .git file": ({ fileSystem, dotGit, gitDir }) =>
      fileSystem.writeFileString(dotGit, `gitdir: ${gitDir}\nworktree: elsewhere\n`),
    "an oversized .git file": ({ fileSystem, dotGit, gitDir }) =>
      fileSystem.writeFileString(dotGit, `gitdir: ${gitDir}${" ".repeat(4096)}\n`),
    "a missing commondir": ({ fileSystem, commonDirFile }) => fileSystem.remove(commonDirFile),
    "an oversized commondir": ({ fileSystem, commonDirFile }) =>
      fileSystem.writeFileString(commonDirFile, `../..${" ".repeat(4096)}\n`),
    "a non-worktree commondir": ({ fileSystem, commonDirFile, root }) =>
      fileSystem.writeFileString(commonDirFile, `${root}\n`),
    "a missing backlink": ({ fileSystem, backlinkFile }) => fileSystem.remove(backlinkFile),
    "a mismatched backlink": ({ fileSystem, backlinkFile, cwd }) =>
      fileSystem.writeFileString(backlinkFile, `${cwd}\n`),
    "an oversized backlink": ({ fileSystem, backlinkFile, dotGit }) =>
      fileSystem.writeFileString(backlinkFile, `${dotGit}${" ".repeat(4096)}\n`),
  } satisfies Record<
    string,
    (fixture: {
      readonly fileSystem: FileSystem.FileSystem;
      readonly root: string;
      readonly cwd: string;
      readonly dotGit: string;
      readonly gitDir: string;
      readonly commonDirFile: string;
      readonly backlinkFile: string;
    }) => Effect.Effect<void, PlatformError.PlatformError>
  >;

  const makeSyntheticWorktree = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const cwd = path.join(root, "checkout");
    const dotGit = path.join(cwd, ".git");
    const gitDir = path.join(root, "repo", ".git", "worktrees", "linked");
    yield* fileSystem.makeDirectory(cwd);
    yield* fileSystem.makeDirectory(gitDir, { recursive: true });
    yield* fileSystem.writeFileString(dotGit, `gitdir: ${gitDir}\n`);
    const commonDirFile = path.join(gitDir, "commondir");
    const backlinkFile = path.join(gitDir, "gitdir");
    yield* fileSystem.writeFileString(commonDirFile, "../..\n");
    yield* fileSystem.writeFileString(backlinkFile, `${dotGit}\n`);
    return { fileSystem, path, root, cwd, dotGit, gitDir, commonDirFile, backlinkFile };
  });

  it.effect("resolves a synthetic linked worktree with a commondir", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd, gitDir } = yield* makeSyntheticWorktree;
      const resolved: VerifiedClientFileRoot | undefined = yield* resolveGitWorktreeDirectory({
        fileSystem,
        path,
        cwd,
      });
      const info = yield* fileSystem.lstat(gitDir);
      assert.deepEqual(resolved, {
        path: gitDir,
        identity: { dev: info.dev, ino: Option.getOrThrow(info.ino) },
      });
    }),
  );

  it.effect("rejects a .git file that grows past the pointer limit while it is read", () =>
    Effect.gen(function* () {
      const fixture = yield* makeSyntheticWorktree;
      const { fileSystem, path, cwd, dotGit, gitDir } = fixture;
      // `/.` segments resolve away, so only the size limit can reject the grown pointer.
      const growth = swapOnce(
        dotGit,
        fileSystem.writeFileString(dotGit, `gitdir: ${gitDir}${"/.".repeat(2100)}\n`),
      );
      const { recording } = recordReads(fileSystem, growth.fire);
      assert.isUndefined(yield* resolveGitWorktreeDirectory({ fileSystem: recording, path, cwd }));
      assert.isTrue(growth.state.fired);
    }),
  );

  it.effect.each(Object.keys(syntheticBreaks) as Array<keyof typeof syntheticBreaks>)(
    "grants no extra root for %s",
    (kind) =>
      Effect.gen(function* () {
        const fixture = yield* makeSyntheticWorktree;
        yield* syntheticBreaks[kind](fixture);
        assert.isUndefined(yield* resolveGitWorktreeDirectory({ ...fixture, cwd: fixture.cwd }));
      }),
  );
});
