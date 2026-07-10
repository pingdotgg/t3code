import {
  type EnvironmentId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { request, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

const OFFLINE_BRANCH_LIST_LIMIT = 100;
const VCS_REFS_REVALIDATE_INTERVAL = "5 seconds";

function canUseVcsRefsCache(input: VcsListRefsInput): boolean {
  return (
    input.query === undefined &&
    input.cursor === undefined &&
    input.includeMatchingRemoteRefs === undefined &&
    input.refKind === undefined &&
    input.limit === OFFLINE_BRANCH_LIST_LIMIT
  );
}

/**
 * Retains the last unfiltered branch-list response for the new-task picker.
 * Filtered or paginated lists intentionally stay live-only: treating a
 * partial result as a complete offline list would make branch selection
 * misleading.
 */
export const makeCachedVcsRefsChanges = Effect.fn("CachedVcsRefsState.makeChanges")(function* (
  input: VcsListRefsInput,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const useCache = canUseVcsRefsCache(input);
  const cached = useCache
    ? yield* cache.loadVcsRefs(environmentId, input.cwd).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not load cached Git refs.").pipe(
            Effect.annotateLogs({
              environmentId,
              cwd: input.cwd,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(Option.none<VcsListRefsResult>()),
          ),
        ),
      )
    : Option.none<VcsListRefsResult>();
  const refresh = Effect.fn("CachedVcsRefsState.refresh")(function* () {
    const refs = yield* request(WS_METHODS.vcsListRefs, input).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    if (useCache) {
      yield* cache.saveVcsRefs(environmentId, input.cwd, refs).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached Git refs.").pipe(
            Effect.annotateLogs({
              environmentId,
              cwd: input.cwd,
              ...safeErrorLogAttributes(error),
            }),
          ),
        ),
      );
    }
    return refs;
  });

  const cachedRefs = Stream.fromEffect(
    SubscriptionRef.get(supervisor.state).pipe(
      Effect.flatMap((connection) =>
        connection.phase === "connected"
          ? Effect.succeed(Option.none<VcsListRefsResult>())
          : Effect.succeed(cached),
      ),
    ),
  ).pipe(
    Stream.filterMap((refs) =>
      Option.match(refs, {
        onNone: () => Result.failVoid,
        onSome: Result.succeed,
      }),
    ),
  );
  const refreshedRefs = Stream.concat(
    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
    SubscriptionRef.changes(supervisor.state),
  ).pipe(
    Stream.map((connection) => (connection.phase === "connected" ? connection.generation : null)),
    Stream.changes,
    Stream.switchMap((generation) =>
      generation === null
        ? Stream.empty
        : Stream.tick(VCS_REFS_REVALIDATE_INTERVAL).pipe(
            Stream.mapEffect(
              () =>
                refresh().pipe(
                  Effect.map(Option.some),
                  Effect.catch((error) =>
                    Effect.logWarning("Could not refresh Git refs.").pipe(
                      Effect.annotateLogs({
                        environmentId,
                        cwd: input.cwd,
                        ...safeErrorLogAttributes(error),
                      }),
                      Effect.as(Option.none<VcsListRefsResult>()),
                    ),
                  ),
                ),
              { concurrency: 1 },
            ),
            Stream.filterMap((refs) =>
              Option.match(refs, {
                onNone: () => Result.failVoid,
                onSome: Result.succeed,
              }),
            ),
          ),
    ),
  );

  return Stream.concat(cachedRefs, refreshedRefs);
});

export function cachedVcsRefsChanges(environmentId: EnvironmentId, input: VcsListRefsInput) {
  return followStreamInEnvironment(environmentId, Stream.unwrap(makeCachedVcsRefsChanges(input)));
}

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const listRefsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((inputKey: string) => {
      const input = JSON.parse(inputKey) as VcsListRefsInput;
      return runtime
        .atom(cachedVcsRefsChanges(environmentId, input))
        .pipe(
          Atom.setIdleTTL(5 * 60_000),
          Atom.withLabel(`environment-data:vcs:list-refs:${environmentId}:${inputKey}`),
        );
    }),
  );
  const listRefs = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsListRefsInput;
  }) => listRefsByEnvironment(target.environmentId)(JSON.stringify(target.input));

  return {
    listRefs,
    status: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:vcs:status",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.subscribeVcsStatus>) =>
        subscribe(WS_METHODS.subscribeVcsStatus, input).pipe(
          Stream.mapAccum(
            () => null as VcsStatusResult | null,
            (current, event) => {
              const next = applyGitStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    pull: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:pull",
      tag: WS_METHODS.vcsPull,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:refresh-status",
      tag: WS_METHODS.vcsRefreshStatus,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    createWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-worktree",
      tag: WS_METHODS.vcsCreateWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    removeWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:remove-worktree",
      tag: WS_METHODS.vcsRemoveWorktree,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    createRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:create-ref",
      tag: WS_METHODS.vcsCreateRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    switchRef: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:switch-ref",
      tag: WS_METHODS.vcsSwitchRef,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    init: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:init",
      tag: WS_METHODS.vcsInit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:snapshot",
      tag: WS_METHODS.vcsPanelSnapshot,
      staleTimeMs: 5_000,
    }),
    panelBranchDetails: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:branch-details",
      tag: WS_METHODS.vcsPanelBranchDetails,
      staleTimeMs: 5_000,
    }),
    panelBranchCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:branch-commits",
      tag: WS_METHODS.vcsPanelBranchCommits,
      staleTimeMs: 5_000,
    }),
    panelStashDetails: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:stash-details",
      tag: WS_METHODS.vcsPanelStashDetails,
      staleTimeMs: 5_000,
    }),
    panelStageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:stage-files",
      tag: WS_METHODS.vcsPanelStageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelUnstageFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:unstage-files",
      tag: WS_METHODS.vcsPanelUnstageFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelDiscardFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:discard-files",
      tag: WS_METHODS.vcsPanelDiscardFiles,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelEnrichWorkingTreeFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:enrich-working-tree-files",
      tag: WS_METHODS.vcsPanelEnrichWorkingTreeFiles,
      staleTimeMs: 5_000,
    }),
    panelReadFileDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:read-file-diff",
      tag: WS_METHODS.vcsPanelReadFileDiff,
      staleTimeMs: 5_000,
    }),
    panelCommitStaged: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:commit-staged",
      tag: WS_METHODS.vcsPanelCommitStaged,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelPullBranch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:pull-branch",
      tag: WS_METHODS.vcsPanelPullBranch,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelPushBranch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:push-branch",
      tag: WS_METHODS.vcsPanelPushBranch,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelDeleteBranch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:delete-branch",
      tag: WS_METHODS.vcsPanelDeleteBranch,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelUndoLatestCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:undo-latest-commit",
      tag: WS_METHODS.vcsPanelUndoLatestCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelRevertCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:revert-commit",
      tag: WS_METHODS.vcsPanelRevertCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelCheckoutCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:checkout-commit",
      tag: WS_METHODS.vcsPanelCheckoutCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelCreateBranchFromCommit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:create-branch-from-commit",
      tag: WS_METHODS.vcsPanelCreateBranchFromCommit,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelMergeBranchIntoCurrent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:merge-branch-into-current",
      tag: WS_METHODS.vcsPanelMergeBranchIntoCurrent,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelRebaseCurrentOnto: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:rebase-current-onto",
      tag: WS_METHODS.vcsPanelRebaseCurrentOnto,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelFetchBranch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:fetch-branch",
      tag: WS_METHODS.vcsPanelFetchBranch,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelFetchRemote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:fetch-remote",
      tag: WS_METHODS.vcsPanelFetchRemote,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelFetchAllRemotes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:fetch-all-remotes",
      tag: WS_METHODS.vcsPanelFetchAllRemotes,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelAddRemote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:add-remote",
      tag: WS_METHODS.vcsPanelAddRemote,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelRemoveRemote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:remove-remote",
      tag: WS_METHODS.vcsPanelRemoveRemote,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelCreateStash: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:create-stash",
      tag: WS_METHODS.vcsPanelCreateStash,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelApplyStash: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:apply-stash",
      tag: WS_METHODS.vcsPanelApplyStash,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelPopStash: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:pop-stash",
      tag: WS_METHODS.vcsPanelPopStash,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelDropStash: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:panel:drop-stash",
      tag: WS_METHODS.vcsPanelDropStash,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    panelCompare: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:panel:compare",
      tag: WS_METHODS.vcsPanelCompare,
      staleTimeMs: 5_000,
    }),
  };
}

export * from "./gitActions.ts";
export * from "./vcsAction.ts";
export * from "./vcsRef.ts";
export * from "./vcsStatus.ts";
