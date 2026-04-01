import { existsSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect, vi } from "vite-plus/test";

import { GitCoreLive, makeGitCore } from "./GitCore.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCommandError } from "@t3tools/contracts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";

// ── Helpers ──

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-core-test-" });
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);

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
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
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

const makeIsolatedGitCore = (executeOverride: GitCoreShape["execute"]) =>
  makeGitCore({ executeOverride }).pipe(
    Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
  );

/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
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
  GitCore | FileSystem.FileSystem
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

function buildLargeText(lineCount = 20_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

function splitNullSeparatedPaths(input: string): string[] {
  return input
    .split("\0")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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
        yield* (yield* GitCore).initRepo({ cwd: tmp });
        expect(existsSync(path.join(tmp, ".git"))).toBe(true);
      }),
    );

    it.effect("listGitBranches reports isRepo: true after init + commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(true);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("workspace helpers", () => {
    it.effect("filterIgnoredPaths chunks large path lists and preserves kept paths", () =>
      Effect.gen(function* () {
        const cwd = "/virtual/repo";
        const relativePaths = Array.from({ length: 340 }, (_, index) => {
          const prefix = index % 3 === 0 ? "ignored" : "kept";
          return `${prefix}/segment-${String(index).padStart(4, "0")}/${"x".repeat(900)}.ts`;
        });
        const expectedPaths = relativePaths.filter(
          (relativePath) => !relativePath.startsWith("ignored/"),
        );

        const seenChunks: string[][] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.join(" ") !== "check-ignore --no-index -z --stdin") {
            return Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "unexpected git command in chunking test",
              }),
            );
          }

          const chunkPaths = splitNullSeparatedPaths(input.stdin ?? "");
          seenChunks.push(chunkPaths);
          const ignoredPaths = chunkPaths.filter((relativePath) =>
            relativePath.startsWith("ignored/"),
          );

          return Effect.succeed({
            code: ignoredPaths.length > 0 ? 0 : 1,
            stdout: ignoredPaths.length > 0 ? `${ignoredPaths.join("\0")}\0` : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        const result = yield* core.filterIgnoredPaths(cwd, relativePaths);

        expect(seenChunks.length).toBeGreaterThan(1);
        expect(seenChunks.flat()).toEqual(relativePaths);
        expect(result).toEqual(expectedPaths);
      }),
    );
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it.effect("returns isRepo: false for non-git directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(false);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("returns the current branch with current: true", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current).toBeDefined();
        expect(current!.current).toBe(true);
      }),
    );

    it.effect("does not include detached HEAD pseudo-refs as branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["checkout", "--detach", "HEAD"]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((branch) => branch.name.startsWith("("))).toBe(false);
        expect(result.branches.some((branch) => branch.current)).toBe(false);
      }),
    );

    it.effect("keeps current branch first and sorts the remaining branches by recency", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "older-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });
        yield* commitWithDate(
          tmp,
          "older.txt",
          "older branch change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "older branch change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer branch change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer branch change",
        );

        // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("older-branch");
        expect(result.branches[1]!.name).toBe("newer-branch");
      }),
    );

    it.effect("keeps default branch right after current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);
        yield* git(tmp, ["remote", "set-head", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "current-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });
        yield* commitWithDate(
          tmp,
          "current.txt",
          "current change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "current change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("current-branch");
        expect(result.branches[1]!.name).toBe(defaultBranch);
        expect(result.branches[2]!.name).toBe("newer-branch");
      }),
    );

    it.effect("lists multiple branches after creating them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-b" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const names = result.branches.map((b) => b.name);
        expect(names).toContain("feature-a");
        expect(names).toContain("feature-b");
      }),
    );

    it.effect("parses separate branch names when column.ui is always enabled", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const createdBranchNames = [
          "go-bin",
          "copilot/rewrite-cli-in-go",
          "copilot/rewrite-cli-in-rust",
        ] as const;
        for (const branchName of createdBranchNames) {
          yield* (yield* GitCore).createBranch({ cwd: tmp, branch: branchName });
        }
        yield* git(tmp, ["config", "column.ui", "always"]);

        const rawBranchOutput = yield* git(tmp, ["branch", "--no-color"], {
          ...process.env,
          COLUMNS: "120",
        });
        expect(
          rawBranchOutput
            .split("\n")
            .some(
              (line) =>
                createdBranchNames.filter((branchName) => line.includes(branchName)).length >= 2,
            ),
        ).toBe(true);

        const realGitCore = yield* GitCore;
        const core = yield* makeIsolatedGitCore((input) =>
          realGitCore.execute(
            input.args[0] === "branch"
              ? {
                  ...input,
                  env: { ...input.env, COLUMNS: "120" },
                }
              : input,
          ),
        );

        const result = yield* core.listBranches({ cwd: tmp });
        const localBranchNames = result.branches
          .filter((branch) => !branch.isRemote)
          .map((branch) => branch.name);

        expect(localBranchNames).toHaveLength(4);
        expect(localBranchNames).toEqual(
          expect.arrayContaining([initialBranch, ...createdBranchNames]),
        );
        expect(
          localBranchNames.some(
            (branchName) =>
              createdBranchNames.filter((createdBranch) => branchName.includes(createdBranch))
                .length >= 2,
          ),
        ).toBe(false);
      }),
    );

    it.effect("isDefault is false when no remote exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.every((b) => !b.isDefault)).toBe(true);
      }),
    );

    it.effect("lists local branches first and remote branches last", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/local-only" });

        const remoteOnlyBranch = "feature/remote-only";
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", "origin", remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const firstRemoteIndex = result.branches.findIndex((branch) => branch.isRemote);

        expect(result.hasOriginRemote).toBe(true);
        expect(firstRemoteIndex).toBeGreaterThan(0);
        expect(result.branches.slice(0, firstRemoteIndex).every((branch) => !branch.isRemote)).toBe(
          true,
        );
        expect(result.branches.slice(firstRemoteIndex).every((branch) => branch.isRemote)).toBe(
          true,
        );
        expect(
          result.branches.some(
            (branch) => branch.name === "feature/local-only" && !branch.isRemote,
          ),
        ).toBe(true);
        expect(
          result.branches.some(
            (branch) => branch.name === "origin/feature/remote-only" && branch.isRemote,
          ),
        ).toBe(true);
      }),
    );

    it.effect("includes remoteName metadata for remotes with slash in the name", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const remoteName = "my-org/upstream";

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", remoteName, remote]);
        yield* git(tmp, ["push", "-u", remoteName, defaultBranch]);

        const remoteOnlyBranch = "feature/remote-with-remote-name";
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", remoteName, remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const remoteBranch = result.branches.find(
          (branch) => branch.name === `${remoteName}/${remoteOnlyBranch}`,
        );

        expect(remoteBranch).toBeDefined();
        expect(remoteBranch?.isRemote).toBe(true);
        expect(remoteBranch?.remoteName).toBe(remoteName);
      }),
    );
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const services = yield* Effect.services();
        const runPromise = Effect.runPromiseWith(services);

        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* (yield* GitCore).createBranch({ cwd: source, branch: featureBranch });
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const details = await runPromise(core.statusDetails(source));
              expect(details.branch).toBe(featureBranch);
              expect(details.aheadCount).toBe(0);
              expect(details.behindCount).toBe(1);
            },
            {
              timeout: 10_000,
              interval: 100,
            },
          ),
        );
      }),
    );

    it.effect("keeps checkout successful when upstream refresh fails", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
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

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
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
          return realGitCore.execute(input);
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
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
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

        const realGitCore = yield* GitCore;
        let fetchArgs: readonly string[] | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            fetchArgs = [...input.args];
            return Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          return realGitCore.execute(input);
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
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
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

        const realGitCore = yield* GitCore;
        let fetchStarted = false;
        let releaseFetch!: () => void;
        const waitForReleasePromise = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") {
            fetchStarted = true;
            return Effect.promise(() =>
              waitForReleasePromise.then(() => ({
                code: 0,
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              })),
            );
          }
          return realGitCore.execute(input);
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
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "nonexistent" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("does not silently checkout a local branch when a remote ref no longer exists", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: source, branch: "feature" });

        const checkoutResult = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: source, branch: "origin/feature" }),
        );
        expect(checkoutResult._tag).toBe("Failure");
        expect(yield* git(source, ["branch", "--show-current"])).toBe(defaultBranch);
      }),
    );

    it.effect("checks out a remote tracking branch when remote name contains slashes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const remoteName = "my-org/upstream";
        const featureBranch = "feature";
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", remoteName, remote]);
        yield* git(source, ["push", "-u", remoteName, defaultBranch]);

        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature content\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature commit"]);
        yield* git(source, ["push", "-u", remoteName, featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);
        yield* git(source, ["branch", "-D", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({
          cwd: source,
          branch: `${remoteName}/${featureBranch}`,
        });

        expect(yield* git(source, ["branch", "--show-current"])).toBe("upstream/feature");
      }),
    );

    it.effect(
      "falls back to detached checkout when --track would conflict with an existing local branch",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          // Keep local branch but remove tracking so `--track origin/<branch>`
          // would attempt to create an already-existing local branch.
          yield* git(source, ["branch", "--unset-upstream"]);

          yield* (yield* GitCore).checkoutBranch({
            cwd: source,
            branch: `origin/${defaultBranch}`,
          });

          const core = yield* GitCore;
          const status = yield* core.statusDetails(source);
          expect(status.branch).toBeNull();
        }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "other" });

        // Create a conflicting change: modify README on current branch
        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        // First, checkout other branch cleanly
        yield* git(tmp, ["stash"]);
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        // Go back to default branch
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });

        // Make uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        // Checkout should fail due to uncommitted changes
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" }),
        );
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
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(
          (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── renameGitBranch ──

  describe("renameGitBranch", () => {
    it.effect("renames the current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");

        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/old-name")).toBe(false);
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("feature/new-name");
      }),
    );

    it.effect("returns success without git invocation when old/new names match", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const current = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!;

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: current.name,
          newBranch: current.name,
        });

        expect(renamed.branch).toBe(current.name);
      }),
    );

    it.effect("appends numeric suffix when target branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-1");
        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session")).toBe(
          true,
        );
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session-1")).toBe(
          true,
        );
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("t3code/feat/session-1");
      }),
    );

    it.effect("increments suffix until it finds an available branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/feat/session-1" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-2");
      }),
    );

    it.effect("uses '--' separator for branch rename arguments", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const realGitCore = yield* GitCore;
        let renameArgs: ReadonlyArray<string> | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "branch" && input.args[1] === "-m") {
            renameArgs = [...input.args];
          }
          return realGitCore.execute(input);
        });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");
        expect(renameArgs).toEqual(["branch", "-m", "--", "feature/old-name", "feature/new-name"]);
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
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* (yield* GitCore).createWorktree({
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
        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        // Verify the worktree is on the new branch
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("creates a worktree for an existing branch when newBranch is omitted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/existing-worktree" });

        const wtPath = path.join(tmp, "wt-existing");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: "feature/existing-worktree",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("feature/existing-worktree");
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("feature/existing-worktree");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          (yield* GitCore).createWorktree({
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
        const mainBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        // listGitBranches from the worktree should show wt-list as current
        const wtBranches = yield* (yield* GitCore).listBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        // Main repo should still show the original branch as current
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect("removeGitWorktree force removes a dirty worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-dirty-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-dirty",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

        const failedRemove = yield* Effect.result(
          (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath }),
        );
        expect(failedRemove._tag).toBe("Failure");
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath, force: true });
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
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-login" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
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

        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        // Worktree exists
        expect(existsSync(result.worktree.path)).toBe(true);

        // Main repo still on original branch
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        // Worktree is on the new branch
        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });

  describe("fetchPullRequestBranch", () => {
    it.effect("fetches a GitHub pull request ref into a local branch without checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteDir = yield* makeTmpDir("git-remote-");
        yield* git(remoteDir, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remoteDir]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "feature/pr-fetch"]);
        yield* writeTextFile(path.join(tmp, "pr-fetch.txt"), "fetch me\n");
        yield* git(tmp, ["add", "pr-fetch.txt"]);
        yield* git(tmp, ["commit", "-m", "Add PR fetch branch"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/pr-fetch"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/pull/55/head"]);
        yield* git(tmp, ["checkout", initialBranch]);

        yield* (yield* GitCore).fetchPullRequestBranch({
          cwd: tmp,
          prNumber: 55,
          branch: "feature/pr-fetch",
        });

        const localBranches = yield* git(tmp, ["branch", "--list", "feature/pr-fetch"]);
        expect(localBranches).toContain("feature/pr-fetch");
        const currentBranch = yield* git(tmp, ["branch", "--show-current"]);
        expect(currentBranch).toBe(initialBranch);
      }),
    );
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-b" });

        // Simulate switching to thread A's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        // Simulate switching to thread B's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        // Switch back to thread A
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
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
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "diverged" });

        // Make diverged branch have different file content
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        // Actually, let's just get back to the initial branch explicitly
        const allBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });

        // Make local uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        // Attempt checkout should fail
        const failedCheckout = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        // Current branch should still be the initial one
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
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

    it.effect(
      "reuses an existing remote when the target URL only differs by a trailing slash after .git",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;

          yield* git(tmp, ["remote", "add", "origin", "git@github.com:pingdotgg/t3code.git"]);

          const remoteName = yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "origin",
            url: "git@github.com:pingdotgg/t3code.git/",
          });

          expect(remoteName).toBe("origin");
          expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean)).toEqual(["origin"]);
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

    it.effect("computes ahead count against base branch when no upstream is configured", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "ahead of base\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const details = yield* core.statusDetails(tmp);
        expect(details.branch).toBe("feature/no-upstream-ahead");
        expect(details.hasUpstream).toBe(false);
        expect(details.aheadCount).toBe(1);
        expect(details.behindCount).toBe(0);
      }),
    );

    it.effect(
      "computes ahead count against origin/default when local default branch is missing",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/remote-base-only"]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of origin/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/remote-base-only");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect(
      "computes ahead count against a non-origin remote-prefixed gh-merge-base candidate",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const remoteName = "fork-seed";
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", remoteName, remote]);
          yield* git(source, ["push", "-u", remoteName, initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/non-origin-merge-base"]);
          yield* git(source, [
            "config",
            "branch.feature/non-origin-merge-base.gh-merge-base",
            `${remoteName}/${initialBranch}`,
          ]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of ${remoteName}/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/non-origin-merge-base");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect("skips push when no upstream is configured and branch is not ahead of base", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("skipped_up_to_date");
        expect(pushed.branch).toBe("feature/no-upstream-no-ahead");
        expect(pushed.setUpstream).toBeUndefined();
      }),
    );

    it.effect("pushes with upstream setup when no comparable base branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=trunk"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/no-base"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("origin/feature/no-base");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-base",
        );
      }),
    );

    it.effect("pushes with upstream setup to the only configured non-origin remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=main"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/fork-only"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("fork/feature/fork-only");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "fork/feature/fork-only",
        );
      }),
    );

    it.effect(
      "pushes with upstream setup when comparable base exists but remote branch is missing",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(tmp);
          const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* writeTextFile(path.join(tmp, "default-ahead.txt"), "ahead on default\n");
          yield* git(tmp, ["add", "default-ahead.txt"]);
          yield* git(tmp, ["commit", "-m", "default ahead"]);

          const featureBranch = "feature/publish-no-upstream";
          yield* git(tmp, ["checkout", "-b", featureBranch]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(true);
          expect(pushed.upstreamBranch).toBe(`origin/${featureBranch}`);
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${featureBranch}`,
          );
          expect(yield* git(tmp, ["ls-remote", "--heads", "origin", featureBranch])).toContain(
            featureBranch,
          );
        }),
    );

    it.effect("prefers branch pushRemote over origin when setting upstream", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);

        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(tmp, ["remote", "add", "origin", origin]);
        yield* git(tmp, ["remote", "add", "fork", fork]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);

        const featureBranch = "feature/push-remote";
        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* git(tmp, ["config", `branch.${featureBranch}.pushRemote`, "fork"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "push to fork\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe(`fork/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `fork/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", "fork", featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect(
      "pushes renamed PR worktree branches to their tracked upstream branch even when push.default is current",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);

          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["remote", "add", "jasonLaster", fork]);
          yield* git(tmp, ["checkout", "-b", "statemachine"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "fork branch"]);
          yield* git(tmp, ["push", "-u", "jasonLaster", "statemachine"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["branch", "-D", "statemachine"]);
          yield* git(tmp, [
            "checkout",
            "-b",
            "t3code/pr-488/statemachine",
            "--track",
            "jasonLaster/statemachine",
          ]);
          yield* git(tmp, ["config", "push.default", "current"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "updated fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "update reviewed PR branch"]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);

          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(false);
          expect(pushed.upstreamBranch).toBe("jasonLaster/statemachine");
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            "jasonLaster/statemachine",
          );
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "statemachine"]),
          ).toContain("statemachine");
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "t3code/pr-488/statemachine"]),
          ).toBe("");
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
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
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

    it.effect("prepareCommitContext stages only selected files when filePaths provided", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp, ["a.txt"]);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).not.toContain("b.txt");

        yield* core.commit(tmp, "Add only a.txt", "");

        // b.txt should still be untracked after commit
        const statusAfter = yield* git(tmp, ["status", "--porcelain"]);
        expect(statusAfter).toContain("b.txt");
        expect(statusAfter).not.toContain("a.txt");
      }),
    );

    it.effect("prepareCommitContext stages everything when filePaths is undefined", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).toContain("b.txt");
      }),
    );

    it.effect("prepareCommitContext truncates oversized staged patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("README.md");
        expect(context!.stagedPatch).toContain("[truncated]");
      }),
    );

    it.effect("readRangeContext truncates oversized diff patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* writeTextFile(path.join(tmp, "large.txt"), buildLargeText());
        yield* git(tmp, ["add", "large.txt"]);
        yield* git(tmp, ["commit", "-m", "Add large range context"]);

        const rangeContext = yield* core.readRangeContext(tmp, initialBranch);
        expect(rangeContext.commitSummary).toContain("Add large range context");
        expect(rangeContext.diffSummary).toContain("large.txt");
        expect(rangeContext.diffPatch).toContain("[truncated]");
      }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/core-push" });

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
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
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
        const result = yield* Effect.result((yield* GitCore).pullCurrentBranch(tmp));
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
        const realGitCore = yield* GitCore;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore((input) => {
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
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );

    it.effect("falls back to empty remote branch data when remote lookups fail", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        const realGitCore = yield* GitCore;
        let didFailRemoteBranches = false;
        let didFailRemoteNames = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.join(" ") === "branch --no-color --no-column --remotes") {
            didFailRemoteBranches = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteBranches",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          if (input.args.join(" ") === "remote") {
            didFailRemoteNames = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteNames",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.every((branch) => !branch.isRemote)).toBe(true);
        expect(didFailRemoteBranches).toBe(true);
        expect(didFailRemoteNames).toBe(true);
      }),
    );
  });
});
