/**
 * Atom families and commands for the source-control panel's `workingCopy.*`
 * RPCs.
 *
 * Every method is unary (there is no `subscribeWorkingCopy` — see
 * `build-log-f4-server.md` deviation 1), so this file holds no stream wiring and
 * `rpc/client.ts` needs no tag-union edit.
 *
 * Two shapes on purpose:
 *
 *  - **Reactive query atoms** for the things the panel keeps on screen
 *    (status, stashes, backups, the amend prefill). Those are refreshed by
 *    `invalidateWorkingCopy` after every mutation.
 *  - **Imperative reads** (`log`, `commitDetail`, `diff`, …) executed through
 *    `useAtomQueryRunner`, because their results are folded into client-owned
 *    paging/merge state rather than rendered straight from the atom.
 *
 * fork: f4 source-control panel
 */
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  type AtomCommandConcurrency,
} from "./runtime.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentUnaryRpcTag } from "../rpc/client.ts";

export interface WorkingCopyTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * One mutation at a time per repository, mirroring the server's per-cwd
 * semaphore. Two repos stay independent, so a slow `stash push` in one project
 * cannot block staging in another.
 */
export const workingCopyCommandScheduler = createAtomCommandScheduler();

/**
 * fork: f4 AI commit message — a SEPARATE lane from the mutation scheduler.
 *
 * Generation is a read that can take tens of seconds. Putting it on
 * `workingCopyCommandScheduler` would make a staging press queue behind a model
 * call in the same repository, which is exactly the freeze the server-side
 * semaphore split avoids.
 */
export const workingCopyGenerationScheduler = createAtomCommandScheduler();

export const workingCopyCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

/**
 * Bumped after every mutation and on every `subscribeVcsStatus` local push.
 * Consumers that own their own paging (history, diffs) read this rather than a
 * query atom, so a re-read is a plain dependency change instead of a subscription.
 */
const revisionByTarget = Atom.family((key: string) =>
  Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel(`environment-data:working-copy:revision:${key}`),
  ),
);

function revisionKey(target: WorkingCopyTarget): string {
  return JSON.stringify([target.environmentId, target.cwd]);
}

export function workingCopyRevisionAtom(target: WorkingCopyTarget) {
  return revisionByTarget(revisionKey(target));
}

export function bumpWorkingCopyRevision(
  registry: AtomRegistry.AtomRegistry,
  target: WorkingCopyTarget,
): void {
  registry.update(workingCopyRevisionAtom(target), (revision) => revision + 1);
}

export function createWorkingCopyEnvironmentAtoms<R, E>(
  // `EnvironmentCacheStore` is required by `invalidateCachedVcsRefs` (Gap B);
  // the same runtime already backs `createVcsEnvironmentAtoms`.
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  // Status is deliberately short-lived in cache but never auto-refreshed: the
  // panel drives every re-read (push, post-mutation, visible-only poll). A
  // `refreshIntervalMs` here would repaint while the panel is hidden.
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:status",
    tag: WS_METHODS.workingCopyStatus,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
  });
  const stashList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:stash-list",
    tag: WS_METHODS.workingCopyStashList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const discardBackups = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:discard-backups",
    tag: WS_METHODS.workingCopyListDiscardBackups,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const lastCommitMessage = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:last-commit-message",
    tag: WS_METHODS.workingCopyLastCommitMessage,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const log = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:log",
    tag: WS_METHODS.workingCopyLog,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
  });
  const commitDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:commit-detail",
    tag: WS_METHODS.workingCopyCommitDetail,
    // A commit is immutable, so its detail can be cached for the session.
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const diff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:diff",
    tag: WS_METHODS.workingCopyDiff,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
  });
  const commitFileDiff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:commit-file-diff",
    tag: WS_METHODS.workingCopyCommitFileDiff,
    staleTimeMs: 5 * 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const fileAtRef = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:working-copy:file-at-ref",
    tag: WS_METHODS.workingCopyFileAtRef,
    staleTimeMs: 1_000,
    idleTtlMs: 60_000,
  });

  /**
   * Post-mutation refresh. The server has no working-copy subscription, so this
   * is the client's half of the liveness contract: refresh the reactive atoms
   * and bump the revision the paged views watch.
   */
  const invalidate = (
    target: { readonly environmentId: EnvironmentId; readonly input: { readonly cwd: string } },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      const scope: WorkingCopyTarget = {
        environmentId: target.environmentId,
        cwd: target.input.cwd,
      };
      const key = { environmentId: scope.environmentId, input: { cwd: scope.cwd } };
      registry.refresh(status(key));
      registry.refresh(lastCommitMessage(key));
      // fork: f4 — the stash list and the backup list are POSITIONAL data:
      // every push/pop/drop renumbers `stash@{n}`. Leaving them stale meant a
      // dropped row stayed on screen and the next Drop press resolved to a
      // different stash than the confirm dialog named. Cheap to refresh — one
      // git invocation each, and they are only mounted while the section is
      // expanded (`idleTtlMs` unmounts them otherwise).
      registry.refresh(stashList(key));
      registry.refresh(discardBackups(key));
      bumpWorkingCopyRevision(registry, scope);
    });

  // Every `workingCopy.*` input carries `cwd` (the containment guard requires
  // it), but that is a fact about the 28 tags rather than something the generic
  // parameter can prove, so the scheduler key and the invalidation target read
  // it through one narrow local assertion instead of widening the helper.
  const cwdOf = (input: unknown): string => (input as { readonly cwd: string }).cwd;

  /**
   * fork: f4 invalidation Gap B — the mutations that MOVE OR CREATE A REF also
   * invalidate the cached ref list, exactly like every upstream `vcs.*` command
   * does (`vcs.ts` passes `invalidateRefs` on all of them).
   *
   * Without it, a tag created from the History context menu, a commit, an amend
   * or a checkout landed on disk but the branch/tag pickers elsewhere in the
   * app kept showing the pre-mutation list until something else happened to
   * refresh it.
   */
  const mutation = <TTag extends EnvironmentUnaryRpcTag>(
    label: string,
    tag: TTag,
    options?: { readonly movesRefs?: boolean },
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label,
      tag,
      scheduler: workingCopyCommandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, cwdOf(input)]),
      },
      onSettled: (target, registry) => {
        const scoped = {
          environmentId: target.environmentId,
          input: { cwd: cwdOf(target.input) },
        };
        return options?.movesRefs === true
          ? Effect.andThen(invalidate(scoped, registry), () =>
              invalidateCachedVcsRefs(registry, {
                environmentId: scoped.environmentId,
                cwd: scoped.input.cwd,
              }),
            )
          : invalidate(scoped, registry);
      },
    });

  /**
   * fork: f4 AI commit message. Not a `mutation`: nothing in the repository
   * changes, so there is nothing to invalidate and no status refresh to push.
   * `singleFlight` keyed by env:cwd:amend means a second press while one is in
   * flight joins the first rather than paying for a second model call.
   */
  const generateCommitMessage = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:working-copy:generate-commit-message",
    tag: WS_METHODS.workingCopyGenerateCommitMessage,
    scheduler: workingCopyGenerationScheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) =>
        JSON.stringify([environmentId, input.cwd, input.amend === true]),
    },
  });

  return {
    status,
    stashList,
    discardBackups,
    lastCommitMessage,
    log,
    commitDetail,
    diff,
    commitFileDiff,
    fileAtRef,
    generateCommitMessage,

    stagePaths: mutation(
      "environment-data:working-copy:stage-paths",
      WS_METHODS.workingCopyStagePaths,
    ),
    unstagePaths: mutation(
      "environment-data:working-copy:unstage-paths",
      WS_METHODS.workingCopyUnstagePaths,
    ),
    applyPatch: mutation(
      "environment-data:working-copy:apply-patch",
      WS_METHODS.workingCopyApplyPatch,
    ),
    discardPaths: mutation(
      "environment-data:working-copy:discard-paths",
      WS_METHODS.workingCopyDiscardPaths,
    ),
    restoreDiscardBackup: mutation(
      "environment-data:working-copy:restore-discard-backup",
      WS_METHODS.workingCopyRestoreDiscardBackup,
    ),
    // fork: f4 Gap B — every mutation below moves or creates a ref.
    commitStaged: mutation(
      "environment-data:working-copy:commit-staged",
      WS_METHODS.workingCopyCommitStaged,
      { movesRefs: true },
    ),
    amendCommit: mutation(
      "environment-data:working-copy:amend-commit",
      WS_METHODS.workingCopyAmendCommit,
      { movesRefs: true },
    ),
    undoLastCommit: mutation(
      "environment-data:working-copy:undo-last-commit",
      WS_METHODS.workingCopyUndoLastCommit,
      { movesRefs: true },
    ),
    stashPush: mutation(
      "environment-data:working-copy:stash-push",
      WS_METHODS.workingCopyStashPush,
    ),
    stashApply: mutation(
      "environment-data:working-copy:stash-apply",
      WS_METHODS.workingCopyStashApply,
    ),
    stashPop: mutation("environment-data:working-copy:stash-pop", WS_METHODS.workingCopyStashPop),
    stashDrop: mutation(
      "environment-data:working-copy:stash-drop",
      WS_METHODS.workingCopyStashDrop,
    ),
    resolveConflict: mutation(
      "environment-data:working-copy:resolve-conflict",
      WS_METHODS.workingCopyResolveConflict,
    ),
    abortOperation: mutation(
      "environment-data:working-copy:abort-operation",
      WS_METHODS.workingCopyAbortOperation,
    ),
    cherryPick: mutation(
      "environment-data:working-copy:cherry-pick",
      WS_METHODS.workingCopyCherryPick,
      { movesRefs: true },
    ),
    revertCommit: mutation(
      "environment-data:working-copy:revert-commit",
      WS_METHODS.workingCopyRevertCommit,
      { movesRefs: true },
    ),
    checkoutCommit: mutation(
      "environment-data:working-copy:checkout-commit",
      WS_METHODS.workingCopyCheckoutCommit,
      { movesRefs: true },
    ),
    resetToCommit: mutation(
      "environment-data:working-copy:reset-to-commit",
      WS_METHODS.workingCopyResetToCommit,
      { movesRefs: true },
    ),
    tagCommit: mutation(
      "environment-data:working-copy:tag-commit",
      WS_METHODS.workingCopyTagCommit,
      { movesRefs: true },
    ),
  };
}

export type WorkingCopyEnvironmentAtoms = ReturnType<typeof createWorkingCopyEnvironmentAtoms>;
