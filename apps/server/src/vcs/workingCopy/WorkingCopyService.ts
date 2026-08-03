/**
 * fork: f4 — the source-control panel's server facade.
 *
 * Two service-level behaviours carry the whole feature:
 *
 * 1. **cwd containment.** Every method validates the caller-supplied `cwd`,
 *    *and* the repository root git resolves it to, against the open project
 *    roots and thread worktrees. Denial throws. An RPC that runs arbitrary git
 *    in an arbitrary directory is a sandbox escape, and this is the only thing
 *    standing between a paired remote client and the host filesystem.
 * 2. **Per-repository mutation serialization.** One mutation at a time per
 *    repository (an Effect `Semaphore` keyed by the resolved root), on top of
 *    the `index.lock` retry in `WorkingCopyGit`. Reads are uncached and
 *    unserialized; the client drives refresh.
 *
 * Everything runs over `VcsDriver.execute`, so `VcsDriver.ts` is untouched.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  WorkingCopyCwdDeniedError,
  // fork: f4 AI commit message
  WorkingCopyNothingStagedError,
  type WorkingCopyAbortOperationInput,
  type WorkingCopyAmendCommitInput,
  type WorkingCopyApplyPatchInput,
  type WorkingCopyBatchResult,
  type WorkingCopyCheckoutCommitInput,
  type WorkingCopyCherryPickInput,
  type WorkingCopyCommitDetail,
  type WorkingCopyCommitDetailInput,
  type WorkingCopyCommitFileDiffInput,
  type WorkingCopyCommitResult,
  type WorkingCopyCommitStagedInput,
  type WorkingCopyCwdInput,
  type WorkingCopyDiffInput,
  type WorkingCopyDiffResult,
  type WorkingCopyDiscardPathsInput,
  type WorkingCopyDiscardResult,
  type WorkingCopyError,
  type WorkingCopyCommitMessageError,
  type WorkingCopyFileAtRefInput,
  type WorkingCopyFileContentResult,
  type WorkingCopyGenerateCommitMessageInput,
  type WorkingCopyGeneratedCommitMessage,
  type WorkingCopyLastCommitMessageResult,
  type WorkingCopyLogInput,
  type WorkingCopyLogPage,
  type WorkingCopyPathsInput,
  type WorkingCopyResetToCommitInput,
  type WorkingCopyResolveConflictInput,
  type WorkingCopyRevertCommitInput,
  type WorkingCopyStashEntry,
  type WorkingCopyStashPushInput,
  type WorkingCopyStashRefInput,
  type WorkingCopyStatusInput,
  type WorkingCopyStatusResult,
  type WorkingCopyTagCommitInput,
} from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
// fork: f4 AI commit message — the existing text-generation stack, reused whole.
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as VcsDriverRegistry from "../VcsDriverRegistry.ts";
import { findContainingRoot, normalizeContainmentPath } from "./cwdContainment.ts";
import { makeWorkingCopyGit, type WorkingCopyGit } from "./WorkingCopyGit.ts";
import * as Commit from "./WorkingCopyCommit.ts";
import * as CommitDetail from "./WorkingCopyCommitDetail.ts";
import * as CommitMessage from "./WorkingCopyCommitMessage.ts";
import * as Conflicts from "./WorkingCopyConflicts.ts";
import * as Diff from "./WorkingCopyDiff.ts";
import * as Discard from "./WorkingCopyDiscard.ts";
import * as HistoryActions from "./WorkingCopyHistoryActions.ts";
import * as Log from "./WorkingCopyLog.ts";
import * as Staging from "./WorkingCopyStaging.ts";
import * as Stash from "./WorkingCopyStash.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";

/**
 * fork: f4 — the shaped negative for a cwd that is inside an open project but
 * is not a git repository. The panel has a dedicated empty state for exactly
 * this; without it the state was dead code.
 */
const NOT_A_REPOSITORY: WorkingCopyStatusResult = {
  isRepo: false,
  refName: null,
  detached: false,
  hasUpstream: false,
  files: [],
  operationInProgress: null,
};

export interface WorkingCopyServiceShape {
  readonly status: (
    input: WorkingCopyStatusInput,
  ) => Effect.Effect<WorkingCopyStatusResult, WorkingCopyError>;
  readonly diff: (
    input: WorkingCopyDiffInput,
  ) => Effect.Effect<WorkingCopyDiffResult, WorkingCopyError>;
  readonly fileAtRef: (
    input: WorkingCopyFileAtRefInput,
  ) => Effect.Effect<WorkingCopyFileContentResult, WorkingCopyError>;
  readonly stagePaths: (
    input: WorkingCopyPathsInput,
  ) => Effect.Effect<WorkingCopyBatchResult, WorkingCopyError>;
  readonly unstagePaths: (
    input: WorkingCopyPathsInput,
  ) => Effect.Effect<WorkingCopyBatchResult, WorkingCopyError>;
  readonly applyPatch: (input: WorkingCopyApplyPatchInput) => Effect.Effect<void, WorkingCopyError>;
  readonly discardPaths: (
    input: WorkingCopyDiscardPathsInput,
  ) => Effect.Effect<WorkingCopyDiscardResult, WorkingCopyError>;
  readonly restoreDiscardBackup: (
    input: WorkingCopyStashRefInput,
  ) => Effect.Effect<void, WorkingCopyError>;
  readonly listDiscardBackups: (
    input: WorkingCopyCwdInput,
  ) => Effect.Effect<ReadonlyArray<WorkingCopyStashEntry>, WorkingCopyError>;
  readonly commitStaged: (
    input: WorkingCopyCommitStagedInput,
  ) => Effect.Effect<WorkingCopyCommitResult, WorkingCopyError>;
  readonly amendCommit: (
    input: WorkingCopyAmendCommitInput,
  ) => Effect.Effect<WorkingCopyCommitResult, WorkingCopyError>;
  readonly undoLastCommit: (input: WorkingCopyCwdInput) => Effect.Effect<void, WorkingCopyError>;
  readonly lastCommitMessage: (
    input: WorkingCopyCwdInput,
  ) => Effect.Effect<WorkingCopyLastCommitMessageResult, WorkingCopyError>;
  /**
   * fork: f4 AI commit message. A read: the staged diff in, text out. Its
   * error channel is wider than every sibling's because only it can fail with
   * "nothing staged" or a model failure.
   */
  readonly generateCommitMessage: (
    input: WorkingCopyGenerateCommitMessageInput,
  ) => Effect.Effect<WorkingCopyGeneratedCommitMessage, WorkingCopyCommitMessageError>;
  readonly log: (input: WorkingCopyLogInput) => Effect.Effect<WorkingCopyLogPage, WorkingCopyError>;
  readonly commitDetail: (
    input: WorkingCopyCommitDetailInput,
  ) => Effect.Effect<WorkingCopyCommitDetail, WorkingCopyError>;
  readonly commitFileDiff: (
    input: WorkingCopyCommitFileDiffInput,
  ) => Effect.Effect<WorkingCopyDiffResult, WorkingCopyError>;
  readonly stashList: (
    input: WorkingCopyCwdInput,
  ) => Effect.Effect<ReadonlyArray<WorkingCopyStashEntry>, WorkingCopyError>;
  readonly stashPush: (input: WorkingCopyStashPushInput) => Effect.Effect<void, WorkingCopyError>;
  readonly stashApply: (input: WorkingCopyStashRefInput) => Effect.Effect<void, WorkingCopyError>;
  readonly stashPop: (input: WorkingCopyStashRefInput) => Effect.Effect<void, WorkingCopyError>;
  readonly stashDrop: (input: WorkingCopyStashRefInput) => Effect.Effect<void, WorkingCopyError>;
  readonly resolveConflict: (
    input: WorkingCopyResolveConflictInput,
  ) => Effect.Effect<void, WorkingCopyError>;
  readonly abortOperation: (
    input: WorkingCopyAbortOperationInput,
  ) => Effect.Effect<void, WorkingCopyError>;
  readonly cherryPick: (
    input: WorkingCopyCherryPickInput,
  ) => Effect.Effect<WorkingCopyCommitResult, WorkingCopyError>;
  readonly revertCommit: (
    input: WorkingCopyRevertCommitInput,
  ) => Effect.Effect<WorkingCopyCommitResult, WorkingCopyError>;
  readonly checkoutCommit: (
    input: WorkingCopyCheckoutCommitInput,
  ) => Effect.Effect<void, WorkingCopyError>;
  readonly resetToCommit: (
    input: WorkingCopyResetToCommitInput,
  ) => Effect.Effect<void, WorkingCopyError>;
  readonly tagCommit: (input: WorkingCopyTagCommitInput) => Effect.Effect<void, WorkingCopyError>;
}

export class WorkingCopyService extends Context.Service<
  WorkingCopyService,
  WorkingCopyServiceShape
>()("t3/vcs/workingCopy/WorkingCopyService") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const projections = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const semaphores = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  // fork: f4 AI commit message — the same three services `GitManager` resolves
  // the writer model from, so the panel and the stacked action cannot drift.
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

  /**
   * Every open project root plus every thread worktree. Read fresh on each
   * call: a project added a second ago must be usable, and a project removed a
   * second ago must not.
   */
  const allowedRoots = Effect.fn("WorkingCopyService.allowedRoots")(function* () {
    const snapshot = yield* projections
      .getShellSnapshot()
      .pipe(Effect.orElseSucceed(() => ({ projects: [], threads: [] }) as const));
    const roots = new Set<string>();
    for (const project of snapshot.projects) {
      roots.add(normalizeContainmentPath(project.workspaceRoot));
    }
    for (const thread of snapshot.threads) {
      if (thread.worktreePath !== null) {
        roots.add(normalizeContainmentPath(thread.worktreePath));
      }
    }
    return roots;
  });

  /** Symlinks must not be a way around containment; compare resolved paths. */
  const realPath = Effect.fn("WorkingCopyService.realPath")(function* (value: string) {
    return yield* fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  });

  const requireContained = Effect.fn("WorkingCopyService.requireContained")(function* (
    operation: string,
    candidate: string,
    roots: ReadonlySet<string>,
    resolvedRoots: ReadonlySet<string>,
  ) {
    if (findContainingRoot(candidate, roots) !== null) {
      return;
    }
    const resolved = yield* realPath(candidate);
    if (findContainingRoot(resolved, resolvedRoots) !== null) {
      return;
    }
    return yield* new WorkingCopyCwdDeniedError({ operation, cwd: candidate });
  });

  /**
   * Guard the requested cwd, resolve the repository, then guard the resolved
   * root as well — otherwise a cwd inside an allowed project that happens to
   * be nested in a *larger* repository would let the panel operate on the
   * outer repository's worktree.
   */
  const openRepository = Effect.fn("WorkingCopyService.openRepository")(function* (
    operation: string,
    cwd: string,
  ) {
    const roots = yield* allowedRoots();
    const resolvedRoots = new Set<string>();
    for (const root of roots) {
      resolvedRoots.add(normalizeContainmentPath(yield* realPath(root)));
    }

    yield* requireContained(operation, cwd, roots, resolvedRoots);
    const handle = yield* registry.resolve({ cwd, requestedKind: "git" });
    const root = handle.repository.rootPath;
    yield* requireContained(operation, root, roots, resolvedRoots);

    return makeWorkingCopyGit(handle.driver, root);
  });

  const semaphoreFor = Effect.fn("WorkingCopyService.semaphoreFor")(function* (root: string) {
    const existing = (yield* Ref.get(semaphores)).get(root);
    if (existing !== undefined) {
      return existing;
    }
    const created = yield* Semaphore.make(1);
    yield* Ref.update(semaphores, (current) => {
      if (current.has(root)) {
        return current;
      }
      const next = new Map(current);
      next.set(root, created);
      return next;
    });
    return (yield* Ref.get(semaphores)).get(root) ?? created;
  });

  /** Reads: no serialization, no cache. */
  const withRepository = <A>(
    operation: string,
    cwd: string,
    run: (git: WorkingCopyGit) => Effect.Effect<A, WorkingCopyError, FileSystem.FileSystem>,
  ): Effect.Effect<A, WorkingCopyError> =>
    openRepository(operation, cwd).pipe(
      Effect.flatMap(run),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

  /** Mutations: one at a time per repository. */
  const runMutating = <A>(
    operation: string,
    cwd: string,
    run: (git: WorkingCopyGit) => Effect.Effect<A, WorkingCopyError, FileSystem.FileSystem>,
  ): Effect.Effect<A, WorkingCopyError> =>
    openRepository(operation, cwd).pipe(
      Effect.flatMap((git) =>
        semaphoreFor(git.cwd).pipe(
          Effect.flatMap((semaphore) => semaphore.withPermits(1)(run(git))),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

  /**
   * fork: f4 AI commit message — `settings.sourceControlWriterModelSelection`
   * when it points at an enabled, available provider, else the global
   * `textGenerationModelSelection`. Byte-for-byte the resolution
   * `GitManager.runStackedAction` performs.
   */
  const resolveTextGenerationSettings = Effect.fn(
    "WorkingCopyService.resolveTextGenerationSettings",
  )(function* () {
    const settings = yield* serverSettingsService.getSettings;
    const modelSelection =
      settings.sourceControlWriterModelSelection === null
        ? settings.textGenerationModelSelection
        : ServerSettings.resolveSourceControlWriterModelSelection(
            settings,
            yield* providerRegistry.getProviders,
          );
    return { modelSelection, style: settings.sourceControlWritingStyle };
  }, Effect.mapError(CommitMessage.settingsFailure));

  /**
   * The git reads run under the repository semaphore so the snapshot is
   * consistent with the panel's own mutations; the **model call does not**. A
   * generation takes tens of seconds, and holding the semaphore across it
   * would freeze staging and committing in that repository for its duration.
   *
   * Settings are read before the containment guard because the guard's cost
   * (`runMutating`) is what tells us whether we may run `git log` for the
   * `repo_conventions` examples. That read is an in-memory settings lookup
   * that returns nothing to the caller and spawns no process, so a denied cwd
   * still reaches git and the model exactly zero times.
   */
  const generateCommitMessage = Effect.fn("WorkingCopyService.generateCommitMessage")(function* (
    input: WorkingCopyGenerateCommitMessageInput,
  ): Effect.fn.Return<WorkingCopyGeneratedCommitMessage, WorkingCopyCommitMessageError> {
    const amend = input.amend === true;
    const settings = yield* resolveTextGenerationSettings();
    const context = yield* runMutating(CommitMessage.OPERATION, input.cwd, (git) =>
      CommitMessage.readCommitMessageContext(git, {
        amend,
        wantsRecentSubjects: CommitMessage.styleNeedsRecentSubjects(settings.style),
      }),
    );
    if (context === null) {
      return yield* new WorkingCopyNothingStagedError({
        operation: CommitMessage.OPERATION,
        cwd: input.cwd,
        amend,
      });
    }
    return yield* CommitMessage.generateCommitMessage(textGeneration, {
      cwd: input.cwd,
      context,
      style: settings.style,
      modelSelection: settings.modelSelection,
    });
  });

  return WorkingCopyService.of({
    status: (input) =>
      withRepository("workingCopy.status", input.cwd, (git) => readWorkingCopyStatus(git)).pipe(
        // fork: f4 — `readWorkingCopyStatus` can only ever answer `isRepo: true`
        // because `registry.resolve` fails first when the cwd is not a git
        // repository, which left the panel's dedicated "not a git repository"
        // empty state unreachable and its 15s poll re-asking a question that
        // can never succeed. Status — and ONLY status — answers the shaped
        // negative instead. The containment guard still runs first, so this
        // does not weaken the security boundary: a denied cwd raises
        // `WorkingCopyCwdDeniedError`, which is a different tag.
        Effect.catchTag("VcsUnsupportedOperationError", () => Effect.succeed(NOT_A_REPOSITORY)),
      ),
    diff: (input) =>
      withRepository("workingCopy.diff", input.cwd, (git) => Diff.readDiff(git, input)),
    fileAtRef: (input) =>
      withRepository("workingCopy.fileAtRef", input.cwd, (git) => Diff.readFileAtRef(git, input)),
    stagePaths: (input) =>
      runMutating("workingCopy.stagePaths", input.cwd, (git) =>
        Staging.stagePaths(git, input.paths),
      ),
    unstagePaths: (input) =>
      runMutating("workingCopy.unstagePaths", input.cwd, (git) =>
        Staging.unstagePaths(git, input.paths),
      ),
    applyPatch: (input) =>
      runMutating("workingCopy.applyPatch", input.cwd, (git) => Staging.applyPatch(git, input)),
    discardPaths: (input) =>
      runMutating("workingCopy.discardPaths", input.cwd, (git) => Discard.discardPaths(git, input)),
    restoreDiscardBackup: (input) =>
      runMutating("workingCopy.restoreDiscardBackup", input.cwd, (git) =>
        Discard.restoreDiscardBackup(git, input.ref),
      ),
    listDiscardBackups: (input) =>
      withRepository("workingCopy.listDiscardBackups", input.cwd, (git) =>
        Discard.listDiscardBackups(git),
      ),
    commitStaged: (input) =>
      runMutating("workingCopy.commitStaged", input.cwd, (git) =>
        Commit.commitStaged(git, input.message),
      ),
    amendCommit: (input) =>
      runMutating("workingCopy.amendCommit", input.cwd, (git) =>
        Commit.amendCommit(git, input.message),
      ),
    undoLastCommit: (input) =>
      runMutating("workingCopy.undoLastCommit", input.cwd, (git) => Commit.undoLastCommit(git)),
    lastCommitMessage: (input) =>
      withRepository("workingCopy.lastCommitMessage", input.cwd, (git) =>
        Commit.lastCommitMessage(git),
      ),
    generateCommitMessage, // fork: f4 AI commit message
    log: (input) => withRepository("workingCopy.log", input.cwd, (git) => Log.readLog(git, input)),
    commitDetail: (input) =>
      withRepository("workingCopy.commitDetail", input.cwd, (git) =>
        CommitDetail.readCommitDetail(git, input.hash),
      ),
    commitFileDiff: (input) =>
      withRepository("workingCopy.commitFileDiff", input.cwd, (git) =>
        Diff.readCommitFileDiff(git, input),
      ),
    stashList: (input) =>
      withRepository("workingCopy.stashList", input.cwd, (git) => Stash.readStashList(git)),
    stashPush: (input) =>
      runMutating("workingCopy.stashPush", input.cwd, (git) => Stash.stashPush(git, input)),
    stashApply: (input) =>
      runMutating("workingCopy.stashApply", input.cwd, (git) => Stash.stashApply(git, input.ref)),
    stashPop: (input) =>
      runMutating("workingCopy.stashPop", input.cwd, (git) => Stash.stashPop(git, input.ref)),
    stashDrop: (input) =>
      runMutating("workingCopy.stashDrop", input.cwd, (git) => Stash.stashDrop(git, input.ref)),
    resolveConflict: (input) =>
      runMutating("workingCopy.resolveConflict", input.cwd, (git) =>
        Conflicts.resolveConflict(git, input),
      ),
    abortOperation: (input) =>
      runMutating("workingCopy.abortOperation", input.cwd, (git) =>
        Conflicts.abortOperation(git, input.operation),
      ),
    cherryPick: (input) =>
      runMutating("workingCopy.cherryPick", input.cwd, (git) =>
        HistoryActions.cherryPick(git, input.hash),
      ),
    revertCommit: (input) =>
      runMutating("workingCopy.revertCommit", input.cwd, (git) =>
        HistoryActions.revertCommit(git, input),
      ),
    checkoutCommit: (input) =>
      runMutating("workingCopy.checkoutCommit", input.cwd, (git) =>
        HistoryActions.checkoutCommit(git, input.hash),
      ),
    resetToCommit: (input) =>
      runMutating("workingCopy.resetToCommit", input.cwd, (git) =>
        HistoryActions.resetToCommit(git, input),
      ),
    tagCommit: (input) =>
      runMutating("workingCopy.tagCommit", input.cwd, (git) =>
        HistoryActions.tagCommit(git, input),
      ),
  });
});

export const layer = Layer.effect(WorkingCopyService, make);
