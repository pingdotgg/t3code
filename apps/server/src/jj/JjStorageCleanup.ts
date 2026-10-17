import type { WorktreeKeepWhen } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjProcess from "../vcs/JjProcess.ts";
import { exactStringPattern } from "../vcs/JjRevset.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveWorkspaceRefName } from "./JjStatus.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const cleanupLayer = JjVcsDriver.layer.pipe(Layer.provideMerge(VcsProcess.layer));

const inspect = Effect.fn("JjStorageCleanup.inspect")(function* (
  cwd: string,
  expectedBookmark: string,
  keepWhen: WorktreeKeepWhen = "uncommitted-changes",
  refreshDefault = false,
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
  const localFilesReason = yield* Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-jj-cleanup-index-",
      });
      const env = { GIT_INDEX_FILE: path.join(temporary, "index") };
      const gitPaths = {
        cwd: paths.workspaceRoot,
        gitDir: paths.gitDir,
        workTree: paths.workspaceRoot,
      };
      // Populate only a private index from jj's current tree: the main workspace's index can
      // describe a different commit, and enumerating the entire tracked tree limits large repos.
      yield* JjProcess.colocatedGitCommand(
        process,
        operation,
        gitPaths,
        ["read-tree", change.commitId],
        { env },
      );
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
          {
            env,
            maxOutputBytes: 1024 * 1024,
          },
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
        if (file !== undefined) {
          return ignored ? `has ignored files (${file})` : `has untracked files (${file})`;
        }
      }
      return null;
    }),
  );
  if (localFilesReason !== null) return { ...result, reason: localFilesReason };
  result.defaultBranch = yield* driver
    .resolveDefaultBookmark(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (result.defaultBranch !== null) {
    const primaryRemote = yield* driver
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (refreshDefault && primaryRemote !== null) {
      yield* JjProcess.jjCommand(
        process,
        operation,
        cwd,
        [
          "git",
          "fetch",
          "--remote",
          primaryRemote,
          "--bookmark",
          exactStringPattern(result.defaultBranch),
        ],
        { ignoreWorkingCopy: true, timeoutMs: 30_000 },
      );
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
) => inspect(cwd, expectedBookmark, keepWhen, refreshDefault).pipe(Effect.provide(cleanupLayer));

export const removeJjStorageCleanup = Effect.fn("JjStorageCleanup.remove")(function* (
  cwd: string,
  expectedBookmark: string,
  expectedCommitId: string,
  keepWhen?: WorktreeKeepWhen,
) {
  return yield* Effect.gen(function* () {
    const inspected = yield* inspect(cwd, expectedBookmark, keepWhen);
    if (inspected.reason !== null) return inspected.reason;
    if (inspected.commitId !== expectedCommitId) return "workspace changed since inspection";
    const process = yield* VcsProcess.VcsProcess;
    // Native removal snapshots again, but does not refuse dirty work. The caller's workspace
    // lease serializes app writers; the inspection above must remain immediately before removal.
    // Auto-track late external files where jj's size/ignore limits allow; rescued work has no bookmark.
    yield* JjProcess.jjCommand(
      process,
      "JjStorageCleanup.remove",
      cwd,
      ["workspace", "remove", workspaceNameForRef(expectedBookmark)],
      {
        config: [["snapshot.auto-track", '"all()"']],
        timeoutMs: 300_000,
      },
    );
    return null;
  }).pipe(Effect.provide(cleanupLayer));
});
