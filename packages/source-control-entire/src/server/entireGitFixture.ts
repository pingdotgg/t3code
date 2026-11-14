// @effect-diagnostics nodeBuiltinImport:off -- The fixture builds real repositories with synchronous git runs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Variables a git hook exports would point the fixture's git at the developer's repository.
const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

// The developer's own git config must not shape the fixture or the patch.
const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !REPOSITORY_SELECTORS.has(name)),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

export function run(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = git(cwd, ...args);
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function commit(cwd: string, files: Record<string, string>, message: string): string {
  for (const [path, contents] of Object.entries(files))
    NodeFS.writeFileSync(NodePath.join(cwd, path), contents);
  run(cwd, "add", "--all");
  run(cwd, "commit", "--quiet", "--message", message);
  return run(cwd, "rev-parse", "HEAD");
}

/**
 * `remote.git` stands in for the Entire repository. The trail's branch leaves `main` after its
 * first commit, and `main` moves on afterwards, so a diff against the base tip would show `c.txt`
 * as removed.
 */
export function makeTrailRepository(
  headFiles: Record<string, string> = { "a.txt": "two\n", "b.txt": "new\n" },
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "entire-trail-"));
  const remote = NodePath.join(root, "remote.git");
  const work = NodePath.join(root, "work");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  run(root, "init", "--quiet", "--initial-branch=main", work);
  run(work, "remote", "add", "origin", remote);
  const base = commit(work, { "a.txt": "one\n" }, "base");
  run(work, "push", "--quiet", "origin", "main");
  run(work, "switch", "--quiet", "--create", "feature");
  const head = commit(work, headFiles, "trail");
  run(work, "push", "--quiet", "origin", "feature");
  run(work, "switch", "--quiet", "main");
  commit(work, { "c.txt": "later\n" }, "main moves on");
  run(work, "push", "--quiet", "origin", "main");
  return {
    work,
    base,
    head,
    /** A clone of `main` alone, which lacks the trail's commits until they are fetched. */
    clone: () => {
      const checkout = NodePath.join(root, "checkout");
      // `--no-local`, or git copies the whole object store and the trail's commits with it.
      run(
        root,
        "clone",
        "--quiet",
        "--no-local",
        "--single-branch",
        "--branch",
        "main",
        remote,
        checkout,
      );
      return checkout;
    },
    cleanup: Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  };
}

/** The host's git, run for real and failing with the exit code as the server's driver does. */
export const realGit: Partial<SourceControlHost.SourceControlHost["Service"]["git"]> = {
  execute: (input) =>
    Effect.suspend(() => {
      const result = git(input.cwd, ...input.args);
      return result.status === 0
        ? Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          })
        : Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "git",
              cwd: input.cwd,
              detail: result.stderr,
              ...(result.status === null ? {} : { exitCode: result.status }),
            }),
          );
    }),
  resolveCommit: ({ cwd, revision }) =>
    Effect.suspend(() => {
      const result = git(cwd, "rev-parse", "--verify", `${revision}^{commit}`);
      return result.status === 0
        ? Effect.succeed({ commitSha: result.stdout.trim() })
        : Effect.fail(
            new GitCommandError({
              operation: "resolveCommit",
              command: "git rev-parse",
              cwd,
              detail: result.stderr,
            }),
          );
    }),
  fetchRemoteTrackingBranch: ({ cwd, remoteName, remoteBranch }) =>
    Effect.suspend(() => {
      const result = git(
        cwd,
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        remoteName,
        `+refs/heads/${remoteBranch}:refs/remotes/${remoteName}/${remoteBranch}`,
      );
      return result.status === 0
        ? Effect.void
        : Effect.fail(
            new GitCommandError({
              operation: "fetchRemoteTrackingBranch",
              command: "git fetch",
              cwd,
              detail: result.stderr,
            }),
          );
    }),
};
