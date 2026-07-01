import { type VcsStatusResult, WS_METHODS } from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createVcsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listRefs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:list-refs",
      tag: WS_METHODS.vcsListRefs,
      staleTimeMs: 5_000,
    }),
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
