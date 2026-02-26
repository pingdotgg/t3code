import { existsSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect, vi } from "vitest";

import { GitServiceLive } from "./GitService.ts";
import { GitService, type GitServiceShape } from "../Services/GitService.ts";
import { GitCoreLive } from "./GitCore.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCommandError } from "../Errors.ts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";

// ── Helpers ──

const GitServiceTestLayer = GitServiceLive.pipe(Layer.provide(NodeServices.layer));
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(GitServiceTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitServiceTestLayer, GitCoreTestLayer);

function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

/** Run a raw git command for test setup (not under test). */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitService> {
  return Effect.gen(function* () {
    const gitService = yield* GitService;
    const result = yield* gitService.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() => {
    const shellPath =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");

    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

    return runProcess(shellPath, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      allowNonZeroExit: true,
      maxBufferBytes: input.maxOutputBytes ?? 1_000_000,
      outputMode: "truncate",
    });
  });
}

const makeIsolatedGitCore = (gitService: GitServiceShape) =>
  Effect.promise(async () => {
    const gitServiceLayer = Layer.succeed(GitService, gitService);
    const coreLayer = GitCoreLive.pipe(
      Layer.provide(gitServiceLayer),
      Layer.provide(NodeServices.layer),
    );
    const core = await Effect.runPromise(Effect.service(GitCore).pipe(Effect.provide(coreLayer)));

    return {
      status: (input) => core.status(input),
      statusDetails: (cwd) => core.statusDetails(cwd),
      prepareCommitContext: (cwd) => core.prepareCommitContext(cwd),
      commit: (cwd, subject, body) => core.commit(cwd, subject, body),
      pushCurrentBranch: (cwd, fallbackBranch) => core.pushCurrentBranch(cwd, fallbackBranch),
      pullCurrentBranch: (cwd) => core.pullCurrentBranch(cwd),
      readRangeContext: (cwd, baseBranch) => core.readRangeContext(cwd, baseBranch),
      readConfigValue: (cwd, key) => core.readConfigValue(cwd, key),
      listBranches: (input) => core.listBranches(input),
      createWorktree: (input) => core.createWorktree(input),
      removeWorktree: (input) => core.removeWorktree(input),
      createBranch: (input) => core.createBranch(input),
      checkoutBranch: (input) => core.checkoutBranch(input),
      initRepo: (input) => core.initRepo(input),
    } satisfies GitCoreShape;
  });

function listGitBranches(input: Parameters<GitCoreShape["listBranches"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.listBranches(input);
  });
}

function initGitRepo(input: Parameters<GitCoreShape["initRepo"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.initRepo(input);
  });
}

function createGitBranch(input: Parameters<GitCoreShape["createBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.createBranch(input);
  });
}

function checkoutGitBranch(input: Parameters<GitCoreShape["checkoutBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.checkoutBranch(input);
  });
}

function createGitWorktree(input: Parameters<GitCoreShape["createWorktree"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.createWorktree(input);
  });
}

function removeGitWorktree(input: Parameters<GitCoreShape["removeWorktree"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.removeWorktree(input);
  });
}

function pullGitBranch({ cwd }: { cwd: string }) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.pullCurrentBranch(cwd);
  });
}

/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | GitService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* initGitRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* writeTextFile(path.join(cwd, fileName), fileContents);
    yield* git(cwd, ["add", fileName]);
    yield* git(cwd, ["commit", "-m", message], {
      ...process.env,
      GIT_AUTHOR_DATE: dateIsoString,
      GIT_COMMITTER_DATE: dateIsoString,
    });
  });
}

// ── Tests ──

it.layer(TestLayer)("git integration", (it) => {
  describe("shell process execution", () => {
    it.effect("caps captured output when maxOutputBytes is exceeded", () =>
      Effect.gen(function* () {
        const result = yield* runShellCommand({
          command: `node -e "process.stdout.write('x'.repeat(2000))"`,
          cwd: process.cwd(),
          timeoutMs: 10_000,
          maxOutputBytes: 128,
        });

        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeLessThanOrEqual(128);
        expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
      }),
    );
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it.effect("creates a valid git repo", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initGitRepo({ cwd: tmp });
        expect(existsSync(path.join(tmp, ".git"))).toBe(true);
      }),
    );

    it.effect("listGitBranches reports isRepo: true after init + commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it.effect("returns isRepo: false for non-git directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.isRepo).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("returns the current branch with current: true", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current).toBeDefined();
        expect(current!.current).toBe(true);
      }),
    );

    it.effect("keeps current branch first and sorts the remaining branches by recency", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* createGitBranch({ cwd: tmp, branch: "older-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "older-branch" });
        yield* commitWithDate(
          tmp,
          "older.txt",
          "older branch change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "older branch change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: initialBranch });
        yield* createGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer branch change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer branch change",
        );

        // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
        yield* checkoutGitBranch({ cwd: tmp, branch: "older-branch" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("older-branch");
        expect(result.branches[1]!.name).toBe("newer-branch");
      }),
    );

    it.effect("keeps default branch right after current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);
        yield* git(tmp, ["remote", "set-head", "origin", defaultBranch]);

        yield* createGitBranch({ cwd: tmp, branch: "current-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "current-branch" });
        yield* commitWithDate(
          tmp,
          "current.txt",
          "current change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "current change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: defaultBranch });
        yield* createGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: "current-branch" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("current-branch");
        expect(result.branches[1]!.name).toBe(defaultBranch);
        expect(result.branches[2]!.name).toBe("newer-branch");
      }),
    );

    it.effect("lists multiple branches after creating them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature-a" });
        yield* createGitBranch({ cwd: tmp, branch: "feature-b" });

        const result = yield* listGitBranches({ cwd: tmp });
        const names = result.branches.map((b) => b.name);
        expect(names).toContain("feature-a");
        expect(names).toContain("feature-b");
      }),
    );

    it.effect("isDefault is false when no remote exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
      }),
    );
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature" });

        yield* checkoutGitBranch({ cwd: tmp, branch: "feature" });

        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* createGitBranch({ cwd: source, branch: featureBranch });
        yield* checkoutGitBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* checkoutGitBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* checkoutGitBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const details = await Effect.runPromise(core.statusDetails(source));
            expect(details.branch).toBe(featureBranch);
            expect(details.aheadCount).toBe(0);
            expect(details.behindCount).toBe(1);
          }),
        );
      }),
    );

    it.effect("keeps checkout successful when upstream refresh fails", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-refresh-failure";
        yield* git(source, ["branch", featureBranch]);
        yield* git(source, ["checkout", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              refreshFetchAttempts += 1;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.refreshFailure",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "simulated fetch timeout",
                }),
              );
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(refreshFetchAttempts).toBe(1);
          }),
        );
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
      }),
    );

    it.effect("refresh fetch is scoped to the checked out branch upstream refspec", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/scoped-fetch";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        let fetchArgs: readonly string[] | null = null;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              fetchArgs = [...input.args];
              return Effect.succeed({ code: 0, stdout: "", stderr: "" });
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(fetchArgs).not.toBeNull();
          }),
        );

        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        expect(fetchArgs).toEqual([
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${featureBranch}:refs/remotes/origin/${featureBranch}`,
        ]);
      }),
    );

    it.effect("returns checkout result before background upstream refresh completes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/background-refresh";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        let fetchStarted = false;
        let releaseFetch: () => void = () => undefined;
        const waitForReleasePromise = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              fetchStarted = true;
              return Effect.promise(() =>
                waitForReleasePromise.then(() => ({ code: 0, stdout: "", stderr: "" })),
              );
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(fetchStarted).toBe(true);
          }),
        );
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        releaseFetch();
      }),
    );

    it.effect("throws when branch does not exist", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(checkoutGitBranch({ cwd: tmp, branch: "nonexistent" }));
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "other" });

        // Create a conflicting change: modify README on current branch
        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        // First, checkout other branch cleanly
        yield* git(tmp, ["stash"]);
        yield* checkoutGitBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        // Go back to default branch
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* checkoutGitBranch({ cwd: tmp, branch: defaultBranch });

        // Make uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        // Checkout should fail due to uncommitted changes
        const result = yield* Effect.result(checkoutGitBranch({ cwd: tmp, branch: "other" }));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it.effect("creates a new branch visible in listGitBranches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(createGitBranch({ cwd: tmp, branch: "dupe" }));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it.effect("creates a worktree with a new branch from the base branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "worktree-out");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-branch",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("wt-branch");
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

        // Clean up worktree before tmp dir disposal
        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        // Verify the worktree is on the new branch
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          createGitWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "existing",
            path: wtPath,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("listGitBranches from worktree cwd reports worktree branch as current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-list-dir");
        const mainBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        // listGitBranches from the worktree should show wt-list as current
        const wtBranches = yield* listGitBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        // Main repo should still show the original branch as current
        const mainBranches = yield* listGitBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect("removeGitWorktree force removes a dirty worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-dirty-dir");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-dirty",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

        const failedRemove = yield* Effect.result(removeGitWorktree({ cwd: tmp, path: wtPath }));
        expect(failedRemove._tag).toBe("Failure");
        expect(existsSync(wtPath)).toBe(true);

        yield* removeGitWorktree({ cwd: tmp, path: wtPath, force: true });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it.effect("init → commit → create branch → checkout → verify current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature-login" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature-login");
      }),
    );
  });

  // ── Full flow: worktree creation from base branch ──

  describe("full flow: worktree creation", () => {
    it.effect("creates worktree with new branch from current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        // Worktree exists
        expect(existsSync(result.worktree.path)).toBe(true);

        // Main repo still on original branch
        const mainBranches = yield* listGitBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        // Worktree is on the new branch
        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "branch-a" });
        yield* createGitBranch({ cwd: tmp, branch: "branch-b" });

        // Simulate switching to thread A's branch
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        // Simulate switching to thread B's branch
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        // Switch back to thread A
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
      }),
    );
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it.effect("uncommitted changes prevent checkout to a diverged branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "diverged" });

        // Make diverged branch have different file content
        yield* checkoutGitBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        // Actually, let's just get back to the initial branch explicitly
        const allBranches = yield* listGitBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* checkoutGitBranch({ cwd: tmp, branch: initialBranch });

        // Make local uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        // Attempt checkout should fail
        const failedCheckout = yield* Effect.result(
          checkoutGitBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        // Current branch should still be the initial one
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
      }),
    );
  });

  describe("GitCore", () => {
    it.effect("supports branch lifecycle operations through the service API", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;

        yield* core.initRepo({ cwd: tmp });
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "initial commit"]);

        yield* core.createBranch({ cwd: tmp, branch: "feature/service-api" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/service-api" });
        const branches = yield* core.listBranches({ cwd: tmp });

        expect(branches.isRepo).toBe(true);
        expect(
          branches.branches.find((branch: { current: boolean; name: string }) => branch.current)
            ?.name,
        ).toBe("feature/service-api");
      }),
    );

    it.effect("reports status details and dirty state", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const clean = yield* core.status({ cwd: tmp });
        expect(clean.hasWorkingTreeChanges).toBe(false);
        expect(clean.branch).toBeTruthy();

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        const dirty = yield* core.statusDetails(tmp);
        expect(dirty.hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect("includes command context when worktree removal fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const missingWorktreePath = path.join(tmp, "missing-worktree");

        const removeResult = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: missingWorktreePath }),
        );
        expect(removeResult._tag).toBe("Failure");
        if (removeResult._tag !== "Failure") {
          return;
        }
        const message = removeResult.failure.message;
        expect(message).toContain("git worktree remove");
        expect(message).toContain(`cwd: ${tmp}`);
        expect(message).toContain(missingWorktreePath);
      }),
    );

    it.effect(
      "refreshes upstream before statusDetails so behind count reflects remote updates",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const clone = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);

          yield* git(clone, ["clone", remote, "."]);
          yield* git(clone, ["config", "user.email", "test@test.com"]);
          yield* git(clone, ["config", "user.name", "Test"]);
          yield* git(clone, [
            "checkout",
            "-B",
            initialBranch,
            "--track",
            `origin/${initialBranch}`,
          ]);
          yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
          yield* git(clone, ["add", "CHANGELOG.md"]);
          yield* git(clone, ["commit", "-m", "remote update"]);
          yield* git(clone, ["push", "origin", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe(initialBranch);
          expect(details.aheadCount).toBe(0);
          expect(details.behindCount).toBe(1);
        }),
    );

    it.effect("prepares commit context by auto-staging and creates commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "new content\n");
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary.length).toBeGreaterThan(0);
        expect(context!.stagedPatch.length).toBeGreaterThan(0);

        const created = yield* core.commit(tmp, "Add README update", "- include updated content");
        expect(created.commitSha.length).toBeGreaterThan(0);
        expect(yield* git(tmp, ["log", "-1", "--pretty=%s"])).toBe("Add README update");
      }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* createGitBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature/core-push" });

        yield* writeTextFile(path.join(tmp, "feature.txt"), "push me\n");
        const core = yield* GitCore;
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        yield* core.commit(tmp, "Add feature file", "");

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/core-push",
        );

        const skipped = yield* core.pushCurrentBranch(tmp, null);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("pulls behind branch and then reports up-to-date", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const pulled = yield* core.pullCurrentBranch(source);
        expect(pulled.status).toBe("pulled");
        expect((yield* core.statusDetails(source)).behindCount).toBe(0);

        const skipped = yield* core.pullCurrentBranch(source);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("top-level pullGitBranch rejects when no upstream exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(pullGitBranch({ cwd: tmp }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message.toLowerCase()).toContain("no upstream");
        }
      }),
    );

    it.effect("lists branches when recency lookup fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitService = yield* GitService;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (!didFailRecency && input.args[0] === "for-each-ref") {
              didFailRecency = true;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.listBranchesRecency",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "timeout",
                }),
              );
            }
            return realGitService.execute(input);
          },
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );
  });
});
