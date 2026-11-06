import { CommandId, GitCommandError, type RunId } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";

const REMOTE_HEAD_TIMEOUT_MS = 5_000;

export type WorktreeHead =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Detached" }
  | { readonly _tag: "Named"; readonly branch: string };

export type WorktreeCheckout =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Detached" }
  /** Records differ, but a thread could not recreate its worktree on this branch: the default branch or one another checkout holds. Its own ref holds HEAD, so nothing is written. */
  | { readonly _tag: "Unbound"; readonly branch: string }
  | { readonly _tag: "Bound"; readonly branch: string }
  /** Records differ, and a write was attempted or deferred. The caller's thread data is stale. */
  | { readonly _tag: "Rebinding"; readonly branch: string };

type WorktreeBranchError = GitCommandError | PlatformError;

export class WorktreeBranches extends Context.Service<
  WorktreeBranches,
  {
    readonly observe: (worktreePath: string) => Effect.Effect<WorktreeHead, WorktreeBranchError>;
    /**
     * Rebinds the worktree's threads to its checked-out branch. `runId` names the one run allowed
     * to stay active during the write. `threadPaths` lists how those threads store the path, when
     * that can differ from `worktreePath`.
     */
    readonly sync: (input: {
      readonly worktreePath: string;
      readonly threadPaths?: ReadonlyArray<string>;
      readonly runId?: RunId;
    }) => Effect.Effect<WorktreeCheckout, WorktreeBranchError>;
    /** False when either side cannot be read, so a caller about to delete keeps what it found. */
    readonly sameRepository: (worktreePath: string, projectRoot: string) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/WorktreeBranches") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const failure = (cwd: string, detail: string) =>
    new GitCommandError({
      operation: "WorktreeBranches.observe",
      command: "git",
      cwd,
      detail,
    });

  // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
  const read = Effect.fnUntraced(function* (cwd: string, args: string[], allowedExitCode?: number) {
    const result = yield* git
      .execute({
        operation: "WorktreeBranches.observe",
        cwd,
        args,
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.flatMap(fs.exists(cwd), (exists) =>
            exists ? Effect.fail(error) : Effect.succeed(null),
          ),
        ),
      );
    if (result === null) return null;
    if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
    const stderr = result.stderr.toLowerCase();
    // Newer Git reports a dangling .git file as "gitfile does not point to a valid repository".
    if (
      stderr.includes("not a git repository") ||
      stderr.includes("does not point to a valid repository")
    )
      return null;
    return yield* failure(
      cwd,
      result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
    );
  });

  const readHead = Effect.fnUntraced(function* (cwd: string) {
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(cwd, ["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return { _tag: "Unavailable" } as const;
    if (head.exitCode !== 0) return { _tag: "Detached" } as const;
    const ref = head.stdout.trim();
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return branch === null || branch.startsWith("(")
      ? ({ _tag: "Unavailable" } as const)
      : ({ _tag: "Named", branch } as const);
  });

  const observe: WorktreeBranches["Service"]["observe"] = Effect.fn("WorktreeBranches.observe")(
    function* (cwd) {
      const index = yield* read(cwd, ["rev-parse", "--git-path", "index"]);
      if (index === null) return { _tag: "Unavailable" };
      if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
        return yield* failure(
          cwd,
          "Git index is locked. Status will resume when the index lock is removed.",
        );
      return yield* readHead(cwd);
    },
  );

  const readMembers = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
    const snapshots = yield* Effect.forEach(paths, (worktreePath) =>
      orchestrator.getShellSnapshot({ worktreePath }),
    );
    return snapshots.flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]);
  });

  const repositoryIdentity = Effect.fnUntraced(function* (cwd: string) {
    const physical = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    const { stdout } = yield* git.execute({
      operation: "WorktreeBranches.sync",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    // Git prints this relative to the physical cwd, which can differ from a symlink.
    const commonDir = yield* physical(path.resolve(yield* physical(cwd), stdout.trim()));
    // By file, not by spelling: a case-insensitive disk accepts one folder under several names.
    return yield* fs.stat(commonDir).pipe(
      Effect.map(({ dev, ino }) =>
        Option.match(ino, {
          onNone: () => commonDir,
          onSome: (value) => `${dev}:${value}`,
        }),
      ),
      Effect.orElseSucceed(() => commonDir),
    );
  });

  const sameRepository: WorktreeBranches["Service"]["sameRepository"] = Effect.fn(
    "WorktreeBranches.sameRepository",
  )(
    function* (worktreePath, projectRoot) {
      return (yield* repositoryIdentity(worktreePath)) === (yield* repositoryIdentity(projectRoot));
    },
    Effect.orElseSucceed(() => false),
  );

  // A replaced folder looks like a switched branch, but its branch means nothing to these threads.
  const inProjectRepository = Effect.fn("WorktreeBranches.inProjectRepository")(
    function* (worktreePath: string, paths: ReadonlyArray<string>) {
      const [member] = yield* readMembers(paths);
      if (member === undefined) return true;
      const project = yield* projects.getShell(member.projectId);
      if (Option.isNone(project)) return false;
      return yield* sameRepository(worktreePath, project.value.workspaceRoot);
    },
    Effect.orElseSucceed(() => false),
  );

  // Once per checkout: a thread left on the default branch syncs at the end of every turn.
  const remoteDefaults = new Map<string, string | null>();

  const isDefaultBranch = Effect.fn("WorktreeBranches.isDefaultBranch")(function* (
    cwd: string,
    branch: string,
  ) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    if (remote === null) return GitVcsDriver.isDefaultBranchName(branch, null);
    const known = yield* git.resolveDefaultBranchName(cwd, remote);
    if (known !== null) return GitVcsDriver.isDefaultBranchName(branch, known);
    // Without a local HEAD ref, only the remote can name its default.
    const key = `${cwd}\0${remote}`;
    let remoteHead = remoteDefaults.get(key);
    if (remoteHead === undefined) {
      remoteHead = yield* git
        .execute({
          operation: "WorktreeBranches.isDefaultBranch",
          cwd,
          args: ["ls-remote", "--symref", "--", remote, "HEAD"],
          timeoutMs: REMOTE_HEAD_TIMEOUT_MS,
        })
        .pipe(
          Effect.map((result) => GitVcsDriver.parseRemoteHeadBranch(result.stdout)),
          Effect.orElseSucceed(() => null),
        );
      remoteDefaults.set(key, remoteHead);
    }
    return GitVcsDriver.isDefaultBranchName(branch, remoteHead);
  });

  // Git refuses to recreate a worktree on a branch another checkout holds.
  const heldByAnotherCheckout = Effect.fn("WorktreeBranches.heldByAnotherCheckout")(function* (
    cwd: string,
    branch: string,
  ) {
    const { stdout } = yield* git.execute({
      operation: "WorktreeBranches.sync",
      cwd,
      args: ["worktree", "list", "--porcelain"],
    });
    const holders = stdout
      .split("\n")
      .filter((line) => line.trim() === `branch refs/heads/${branch}`);
    return holders.length > 1;
  });

  const writeMembers = Effect.fn("WorktreeBranches.writeMembers")(function* (input: {
    readonly paths: ReadonlyArray<string>;
    readonly branch: string;
    readonly runId: RunId | undefined;
  }) {
    const { paths, branch, runId } = input;
    // Oldest first so parents are written before children; reread for threads created mid-write.
    const visited = new Set<string>();
    while (true) {
      const members = yield* readMembers(paths);
      // A sibling's agent may be mid-checkout, so HEAD proves nothing yet. Its run end syncs.
      if (members.some((member) => member.activeRunId !== null && member.activeRunId !== runId))
        return;
      const pending = members
        .filter((member) => !visited.has(member.id) && member.branch !== branch)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        );
      if (pending.length === 0) return;
      for (const member of pending) {
        visited.add(member.id);
        // Random ids: a deterministic receipt would block a later A to B to A to B sequence.
        const uuid = yield* randomUuidV4;
        yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:worktree-branch:${member.id}:${uuid}`),
            threadId: member.id,
            branch,
            expectedBranch: member.branch,
            expectedWorktreePath: member.worktreePath,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree branch update failed", {
                threadId: member.id,
                branch,
                cause,
              }),
            ),
          );
      }
    }
  });

  const sync: WorktreeBranches["Service"]["sync"] = Effect.fn("WorktreeBranches.sync")(function* ({
    worktreePath,
    threadPaths,
    runId,
  }) {
    // Not `observe`: a held index lock says nothing about which branch is checked out.
    const head = yield* readHead(worktreePath);
    if (head._tag !== "Named") return head;
    const { branch } = head;
    const paths = threadPaths ?? [worktreePath];
    // Every thread, not only the caller's: a sibling's write may have been deferred to this sync.
    const bound = yield* readMembers(paths).pipe(
      Effect.map((members) => members.every((member) => member.branch === branch)),
      // The write below reads again and logs a read that keeps failing.
      Effect.orElseSucceed(() => false),
    );
    if (bound) return { _tag: "Bound", branch };
    const born = yield* git.execute({
      operation: "WorktreeBranches.sync",
      cwd: worktreePath,
      args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      allowNonZeroExit: true,
    });
    if (born.exitCode !== 0) return { _tag: "Unavailable" };
    if (!(yield* inProjectRepository(worktreePath, paths))) return { _tag: "Unavailable" };
    if (
      (yield* isDefaultBranch(worktreePath, branch)) ||
      (yield* heldByAnotherCheckout(worktreePath, branch))
    )
      return { _tag: "Unbound", branch };
    yield* writeMembers({ paths, branch, runId }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("worktree branch sync could not read its threads", {
          worktreePath,
          branch,
          cause,
        }),
      ),
    );
    return { _tag: "Rebinding", branch };
  });

  return WorktreeBranches.of({ observe, sync, sameRepository });
});

export const layer = Layer.effect(WorktreeBranches, make);
