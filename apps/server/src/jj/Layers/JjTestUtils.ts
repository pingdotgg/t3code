import path from "node:path";

import { Effect, FileSystem, PlatformError, Scope } from "effect";

import { GitCommandError } from "@t3tools/contracts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { JjCore } from "../Services/JjCore.ts";

export function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

export function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

export function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  GitCommandError,
  GitCore
> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "JjTestUtils.runGit",
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: 30_000,
    });
  });
}

export function runJj(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() =>
    runProcess("jj", args, {
      cwd,
      timeoutMs: 30_000,
      allowNonZeroExit,
    }),
  );
}

export function runJjStdout(cwd: string, args: readonly string[]): Effect.Effect<string, Error> {
  return runJj(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));
}

export function parseJsonLines<T>(stdout: string): T[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function listBookmarks(cwd: string) {
  return runJjStdout(cwd, ["bookmark", "list", "--all-remotes", "-T", 'json(self) ++ "\\n"']).pipe(
    Effect.map(
      (
        stdout,
      ): Array<{
        name?: string;
        remote?: string;
        target?: string[];
        tracking_target?: string[];
      }> => parseJsonLines(stdout),
    ),
  );
}

/**
 * Initialize a JJ repo with git backend, auto-track disabled, and an initial
 * commit on "main".  Uses jj-native commands for the commit workflow;
 * git is only touched for user config required by the git backend.
 */
export function initJjRepo(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitCommandError | PlatformError.PlatformError | Error,
  GitCore | JjCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const jjCore = yield* JjCore;
    yield* jjCore.initRepo({ cwd });

    // Disable auto-tracking so tests exercise the explicit `jj file track`
    // path — the same path production repos with `snapshot.auto-track = "none()"`
    // will hit.
    yield* runJj(cwd, ["config", "set", "--repo", "snapshot.auto-track", "none()"]).pipe(
      Effect.asVoid,
    );

    // Git backend needs author/committer identity.
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);

    // Seed the repo with a committed README using jj-native commands.
    yield* writeTextFile(path.join(cwd, "README.md"), "hello\n");
    yield* runJj(cwd, ["file", "track", "README.md"]).pipe(Effect.asVoid);
    yield* runJj(cwd, ["describe", "-m", "Initial commit"]).pipe(Effect.asVoid);
    yield* runJj(cwd, ["bookmark", "create", "main", "-r", "@"]).pipe(Effect.asVoid);
    yield* runJj(cwd, ["new"]).pipe(Effect.asVoid);
    // Export to git so that bare-remote push tests see a main branch.
    yield* runJj(cwd, ["git", "export"]).pipe(Effect.asVoid);

    return { initialBranch: "main" };
  });
}

/**
 * Add a named git remote, fetch to discover remote state, track a bookmark,
 * and push it.
 */
export function addRemoteAndPush(
  cwd: string,
  remoteName: string,
  remoteDir: string,
  bookmark = "main",
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    yield* runJj(cwd, ["git", "remote", "add", remoteName, remoteDir]);
    // Fetch so jj sees the (empty) remote state, then track + push.
    yield* runJj(cwd, ["git", "fetch", "--remote", remoteName], true);
    yield* runJj(cwd, ["bookmark", "track", `${bookmark}@${remoteName}`], true);
    yield* runJj(cwd, ["git", "push", "--remote", remoteName, "-b", bookmark]);
  }).pipe(Effect.asVoid);
}

/**
 * Create a bare git remote.  This is intentionally git — JJ push/fetch
 * operates over git remotes.
 */
export function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t3code-jj-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}
