import type { WorktreeKeepWhen } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjProcess from "../vcs/JjProcess.ts";
import { STATUS_UPSTREAM_REFRESH_ENV } from "../vcs/GitVcsDriverCore.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveWorkspaceRefName } from "./JjStatus.ts";
import { workspaceNameForRef, workspacePruneLock } from "./JjWorkspaces.ts";

const cleanupLayer = JjVcsDriver.layer.pipe(Layer.provideMerge(VcsProcess.layer));

class JjStorageCleanupRecoveryError extends Data.TaggedError("JjStorageCleanupRecoveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const inspectDisk = Effect.fn("JjStorageCleanup.inspectDisk")(function* (
  process: VcsProcess.VcsProcess["Service"],
  gitPaths: JjProcess.ColocatedGitInput,
  commitId: string,
  keepWhen: WorktreeKeepWhen,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-jj-cleanup-index-",
      });
      const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
      const operation = "JjStorageCleanup.inspectDisk";
      yield* JjProcess.colocatedGitCommand(process, operation, gitPaths, ["read-tree", commitId], {
        env,
      });
      // jj does not manage submodule worktrees. Recursive workspace deletion cannot
      // preserve their local files/history, so never remove a workspace with gitlinks.
      const index = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        gitPaths,
        ["ls-files", "--stage", "-z"],
        // Stage records include object ids and paths: allow millions of entries,
        // including SHA-256 ids/longer paths. Stay below V8's string-length limit
        // so truncation can still fail closed instead of failing during decoding.
        { env, maxOutputBytes: 384 * 1024 * 1024 },
      );
      if (index.stdoutTruncated || index.stderrTruncated || index.stderr.trim() !== "")
        return "submodules could not be inspected";
      // Stage records are NUL-delimited; tabs/newlines in paths are not record boundaries.
      for (let offset = 0; offset < index.stdout.length; ) {
        if (index.stdout.startsWith("160000 ", offset)) return "has submodules";
        const end = index.stdout.indexOf("\0", offset);
        if (end === -1) return "submodules could not be inspected";
        offset = end + 1;
      }
      const tracked = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        gitPaths,
        ["diff", "--quiet", "--ignore-submodules=none", commitId, "--"],
        { env, allowNonZeroExit: true },
      );
      if (tracked.exitCode !== 0 || tracked.stderr.trim() !== "" || tracked.stderrTruncated)
        return "has unsnapshotted tracked changes or could not verify tracked files";
      for (const ignored of keepWhen === "any-local-files" ? [false, true] : [false]) {
        const listed = yield* JjProcess.colocatedGitCommand(
          process,
          operation,
          gitPaths,
          [
            "ls-files",
            "--others",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            ...(ignored ? ["--ignored"] : []),
            "-z",
          ],
          { env, maxOutputBytes: 1024 * 1024 },
        );
        if (listed.stdoutTruncated) return "local files exceed the inspection limit";
        const file = listed.stdout
          .split("\0")
          .find(
            (entry) =>
              entry !== "" &&
              entry !== ".git" &&
              entry !== ".jj" &&
              !entry.startsWith(".jj/") &&
              !entry.startsWith(".git/") &&
              !(ignored && /(^|\/)node_modules\/$/.test(entry)),
          );
        if (file !== undefined)
          return ignored ? `has ignored files (${file})` : `has untracked files (${file})`;
      }
      return null;
    }),
  );
});

const inspect = Effect.fn("JjStorageCleanup.inspect")(function* (
  cwd: string,
  expectedBookmark: string,
  keepWhen: WorktreeKeepWhen = "uncommitted-changes",
  refreshDefault = false,
  defaultBranches?: Map<string, string | null>,
  inspectDefault = true,
) {
  const driver = yield* JjVcsDriver.JjVcsDriver;
  const process = yield* VcsProcess.VcsProcess;
  const operation = "JjStorageCleanup.inspect";
  const paths = yield* driver.ensureUsable(operation, cwd);
  const result = {
    reason: null as string | null,
    commitId: "",
    integrated: false,
    defaultBranch: null as string | null,
    mainWorkspaceRoot: paths.mainWorkspaceRoot,
  };
  if (!paths.isSecondaryWorkspace || paths.workspaceRoot === paths.mainWorkspaceRoot) {
    return { ...result, reason: "is the main Jujutsu workspace" };
  }
  const workspaces = yield* driver.listWorkspaces(cwd);
  const workspace = workspaces.find((entry) => entry.root === paths.workspaceRoot);
  if (workspace?.name !== workspaceNameForRef(expectedBookmark)) {
    return { ...result, reason: "workspace no longer belongs to the expected bookmark" };
  }

  // Snapshot tracked edits without changing the user's untracked-file policy. Untracked files
  // are inspected independently below, including files larger than jj's auto-track limits.
  const snapshot = yield* JjProcess.jjCommand(process, operation, cwd, ["status"], {
    config: [["snapshot.auto-track", '"none()"']],
    maxOutputBytes: 64 * 1024,
  });
  if (snapshot.stdoutTruncated || snapshot.stderrTruncated || snapshot.stderr.trim() !== "") {
    return {
      ...result,
      reason: "working-copy snapshot has warnings or exceeds the inspection limit",
    };
  }
  const change = yield* driver.changeAt(cwd, "@");
  if (change === null) return { ...result, reason: "working-copy commit is unavailable" };
  const parent =
    change.empty && change.parentCommitIds.length === 1
      ? change.parentCommitIds[0]!
      : change.commitId;
  result.commitId = parent;
  if (!change.empty || change.conflict || change.parentCommitIds.length !== 1) {
    return { ...result, reason: "has uncommitted changes or conflicts" };
  }
  if (change.description !== "") {
    return { ...result, reason: "has a working-copy description" };
  }
  const segment = yield* driver.currentSegment(cwd);
  if ((yield* resolveWorkspaceRefName(driver, cwd, segment)) !== expectedBookmark) {
    return { ...result, reason: "workspace no longer belongs to the expected bookmark" };
  }

  // The segment alone misses unbookmarked ancestry across merges and remote-only history.
  // Only the disposable empty @ is excluded; every ancestor needs a surviving ref.
  const stranded = yield* JjProcess.jjCommand(
    process,
    operation,
    cwd,
    [
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      '"1"',
      "-r",
      "(::@ ~ @) ~ ::(bookmarks() | remote_bookmarks())",
    ],
    { ignoreWorkingCopy: true },
  );
  if (stranded.stdout !== "") {
    return { ...result, reason: "has commits not reachable from any bookmark" };
  }
  const conflicts = yield* JjProcess.jjCommand(
    process,
    operation,
    cwd,
    ["log", "--no-graph", "--limit", "1", "-T", '"1"', "-r", "::@ & conflicts()"],
    { ignoreWorkingCopy: true },
  );
  if (conflicts.stdout !== "") {
    return { ...result, reason: "has conflicts" };
  }
  const localFilesReason = yield* inspectDisk(
    process,
    { cwd: paths.workspaceRoot, gitDir: paths.gitDir, workTree: paths.workspaceRoot },
    change.commitId,
    keepWhen,
  );
  if (localFilesReason !== null) return { ...result, reason: localFilesReason };
  // Age/deletion eligibility needs only the safety checks above, not remote discovery.
  if (!inspectDefault) return result;
  const primaryRemote = yield* driver
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  const gitPaths = { gitDir: paths.gitDir, cwd: paths.mainWorkspaceRoot };
  if (primaryRemote !== null) {
    const defaultBranchKey = `${paths.mainWorkspaceRoot}\0${primaryRemote}`;
    let branch = defaultBranches?.get(defaultBranchKey);
    if (branch === undefined) {
      // A conventional local bookmark can be a feature branch. Only the remote's
      // HEAD (cached locally when available) identifies its default for cleanup.
      const remoteHead = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        gitPaths,
        ["symbolic-ref", "--quiet", `refs/remotes/${primaryRemote}/HEAD`],
        { allowNonZeroExit: true },
      );
      const prefix = `refs/remotes/${primaryRemote}/`;
      const localHead = remoteHead.stdout.trim();
      branch =
        remoteHead.exitCode === 0 && localHead.startsWith(prefix)
          ? localHead.slice(prefix.length)
          : yield* JjProcess.colocatedGitCommand(
              process,
              operation,
              gitPaths,
              ["ls-remote", "--symref", "--", primaryRemote, "HEAD"],
              { env: STATUS_UPSTREAM_REFRESH_ENV, timeoutMs: 20_000 },
            ).pipe(
              Effect.map(
                (response) =>
                  /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(response.stdout)?.[1] ?? null,
              ),
              Effect.orElseSucceed(() => null),
            );
      defaultBranches?.set(defaultBranchKey, branch);
    }
    result.defaultBranch = branch;
  } else {
    result.defaultBranch = yield* driver
      .resolveDefaultBookmark(cwd)
      .pipe(Effect.orElseSucceed(() => null));
  }
  if (result.defaultBranch !== null) {
    if (primaryRemote !== null) {
      // Fetch into private Git refs, never moving or conflicting local jj bookmarks.
      if (refreshDefault) {
        yield* JjProcess.colocatedGitCommand(
          process,
          operation,
          gitPaths,
          [
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--prune",
            "--refmap=",
            primaryRemote,
            `+refs/heads/*:refs/t3/remotes/${encodeURIComponent(primaryRemote)}/*`,
          ],
          { env: STATUS_UPSTREAM_REFRESH_ENV, timeoutMs: 30_000 },
        );
      }
      const available = yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        gitPaths,
        [
          "rev-parse",
          "--verify",
          `refs/t3/remotes/${encodeURIComponent(primaryRemote)}/${result.defaultBranch}^{commit}`,
        ],
        { allowNonZeroExit: true },
      );
      if (available.exitCode === 0) {
        const integrated = yield* JjProcess.colocatedGitCommand(
          process,
          operation,
          gitPaths,
          [
            "merge-base",
            "--is-ancestor",
            parent,
            `refs/t3/remotes/${encodeURIComponent(primaryRemote)}/${result.defaultBranch}`,
          ],
          { allowNonZeroExit: true },
        );
        if (integrated.exitCode !== 0 && integrated.exitCode !== 1) {
          return { ...result, reason: "could not compare the refreshed default branch" };
        }
        result.integrated = integrated.exitCode === 0;
        return result;
      }
      if (refreshDefault) return { ...result, reason: "refreshed default branch is unavailable" };
    }
    const bookmarks = yield* driver.listBookmarks(cwd);
    const defaultBookmark = bookmarks.find(
      (entry) =>
        entry.name === result.defaultBranch &&
        entry.remote === primaryRemote &&
        !entry.conflict &&
        entry.target !== null,
    );
    if (defaultBookmark?.target != null) {
      const unintegrated = yield* JjProcess.jjCommand(
        process,
        operation,
        cwd,
        [
          "log",
          "--no-graph",
          "--limit",
          "1",
          "-T",
          '"1"',
          "-r",
          `${parent} ~ ::${defaultBookmark.target}`,
        ],
        { ignoreWorkingCopy: true },
      );
      result.integrated = unintegrated.stdout === "";
    }
  }
  return result;
});

export const inspectJjStorageCleanup = (
  cwd: string,
  expectedBookmark: string,
  keepWhen?: WorktreeKeepWhen,
  refreshDefault?: boolean,
  defaultBranches?: Map<string, string | null>,
  inspectDefault?: boolean,
) =>
  inspect(cwd, expectedBookmark, keepWhen, refreshDefault, defaultBranches, inspectDefault).pipe(
    Effect.catchTag("VcsUnsupportedOperationError", (error) =>
      Effect.succeed({
        reason: `Jujutsu metadata is present: ${error.detail}`,
        commitId: "",
        integrated: false,
        defaultBranch: null,
        mainWorkspaceRoot: cwd,
      }),
    ),
    Effect.provide(cleanupLayer),
  );

export const removeJjStorageCleanup = Effect.fn("JjStorageCleanup.remove")(function* (
  cwd: string,
  expectedBookmark: string,
  expectedCommitId: string,
  keepWhen?: WorktreeKeepWhen,
) {
  return yield* Effect.gen(function* () {
    const inspected = yield* inspect(cwd, expectedBookmark, keepWhen, false, undefined, false);
    if (inspected.reason !== null) return inspected.reason;
    if (inspected.commitId !== expectedCommitId) return "workspace changed since inspection";
    const process = yield* VcsProcess.VcsProcess;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* JjVcsDriver.JjVcsDriver;
    const paths = yield* driver.repoPaths(cwd);
    const gitDir = paths.gitDir;
    if (gitDir === null) return "workspace has no colocated Git metadata";
    const workspaceName = workspaceNameForRef(expectedBookmark);
    const before = yield* driver.changeAt(paths.mainWorkspaceRoot, `${workspaceName}@`);
    // App writers are serialized by the lease and live sessions/terminals are excluded.
    // Rename closes the normal path-based write window; open file descriptors remain
    // the responsibility of those guards. The unscoped holding directory is never
    // automatically deleted on failure: failed restoration must preserve user files.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const temporary = yield* fileSystem.makeTempDirectory({
          directory: path.dirname(paths.workspaceRoot),
          prefix: ".t3-cleanup-",
        });
        const held = path.join(temporary, "workspace");
        const renamed = yield* fileSystem.rename(paths.workspaceRoot, held).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!renamed) {
          yield* fileSystem.remove(temporary, { recursive: true });
          return "workspace is in use or could not be moved for inspection";
        }
        let forgotten = false;
        const result = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const reason = yield* inspectDisk(
                process,
                { cwd: paths.mainWorkspaceRoot, gitDir, workTree: held },
                before?.commitId ?? expectedCommitId,
                keepWhen ?? "uncommitted-changes",
              );
              if (reason !== null) return reason;
              const after = yield* driver.changeAt(paths.mainWorkspaceRoot, `${workspaceName}@`);
              if (
                before === null ||
                after === null ||
                !after.empty ||
                after.description !== "" ||
                after.conflict ||
                before.commitId !== after.commitId ||
                after.parentCommitIds.length !== 1 ||
                after.parentCommitIds[0] !== expectedCommitId
              ) {
                return "workspace changed since inspection";
              }
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* JjProcess.jjCommand(
                    process,
                    "JjStorageCleanup.remove",
                    paths.mainWorkspaceRoot,
                    ["workspace", "forget", workspaceName],
                    { ignoreWorkingCopy: true, timeoutMs: 300_000 },
                  );
                  forgotten = true;
                }),
              );
              yield* JjProcess.colocatedGitCommand(
                process,
                "JjStorageCleanup.remove",
                { cwd: paths.mainWorkspaceRoot, gitDir },
                ["worktree", "prune", "--expire=now"],
              );
              yield* driver.invalidateRepoCaches(paths.mainWorkspaceRoot);
              yield* fileSystem.remove(temporary, { recursive: true });
              return null;
            }),
          ),
        );
        if (!forgotten) {
          const registered = yield* driver.listWorkspaces(paths.mainWorkspaceRoot).pipe(
            Effect.map((entries) => entries.some((entry) => entry.name === workspaceName)),
            Effect.mapError(
              (error) =>
                new JjStorageCleanupRecoveryError({
                  message: `Could not verify workspace registration; recover preserved files from ${held}`,
                  cause: error,
                }),
            ),
          );
          if (!registered)
            return yield* Effect.fail(
              new JjStorageCleanupRecoveryError({
                message: `Workspace registration changed; recover preserved files from ${held}`,
              }),
            );
          // Do not overwrite a concurrently recreated path. Leave the holding path intact
          // if restoration fails, and include its location in the reported error.
          if (yield* fileSystem.exists(paths.workspaceRoot))
            return yield* Effect.fail(
              new JjStorageCleanupRecoveryError({
                message: `Workspace path was recreated; recover preserved files from ${held}`,
              }),
            );
          yield* fileSystem.rename(held, paths.workspaceRoot).pipe(
            Effect.mapError(
              (error) =>
                new JjStorageCleanupRecoveryError({
                  message: `Could not restore workspace; recover preserved files from ${held}`,
                  cause: error,
                }),
            ),
          );
          yield* fileSystem.remove(temporary, { recursive: true });
        }
        if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
        return result.value;
      }),
    );
  }).pipe(workspacePruneLock.withPermit, Effect.provide(cleanupLayer));
});
