import type {
  EnvironmentId,
  VcsPanelBranchCommitsResult,
  VcsPanelBranchDetails,
  VcsPanelCompareResult,
  VcsPanelFileDiffResult,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo } from "react";

import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { vcsEnvironment } from "./vcs";

export class SourceControlPanelCommandInterrupted extends Error {
  constructor() {
    super("Source control panel command was interrupted.");
    this.name = "SourceControlPanelCommandInterrupted";
  }
}

export function isSourceControlPanelCommandInterrupted(
  value: unknown,
): value is SourceControlPanelCommandInterrupted {
  return value instanceof SourceControlPanelCommandInterrupted;
}

async function unwrapPanelCommand<TResult>(
  result: AtomCommandResult<TResult, unknown>,
): Promise<TResult> {
  if (result._tag === "Success") {
    return result.value;
  }
  if (isAtomCommandInterrupted(result)) {
    throw new SourceControlPanelCommandInterrupted();
  }
  throw squashAtomCommandFailure(result);
}

export function useSourceControlPanelApi(environmentId: EnvironmentId) {
  const panelSnapshot = useAtomQueryRunner(vcsEnvironment.panelSnapshot, {
    forceRefresh: true,
    reportFailure: false,
  });
  const panelBranchDetails = useAtomQueryRunner(vcsEnvironment.panelBranchDetails, {
    forceRefresh: true,
    reportFailure: false,
  });
  const panelBranchCommits = useAtomQueryRunner(vcsEnvironment.panelBranchCommits, {
    forceRefresh: true,
    reportFailure: false,
  });
  const panelStashDetails = useAtomQueryRunner(vcsEnvironment.panelStashDetails, {
    forceRefresh: true,
    reportFailure: false,
  });
  const panelStageFiles = useAtomCommand(vcsEnvironment.panelStageFiles, { reportFailure: false });
  const panelUnstageFiles = useAtomCommand(vcsEnvironment.panelUnstageFiles, {
    reportFailure: false,
  });
  const panelDiscardFiles = useAtomCommand(vcsEnvironment.panelDiscardFiles, {
    reportFailure: false,
  });
  const panelEnrichWorkingTreeFiles = useAtomQueryRunner(
    vcsEnvironment.panelEnrichWorkingTreeFiles,
    {
      forceRefresh: true,
      reportFailure: false,
    },
  );
  const panelReadFileDiff = useAtomQueryRunner(vcsEnvironment.panelReadFileDiff, {
    forceRefresh: true,
    reportFailure: false,
  });
  const panelCommitStaged = useAtomCommand(vcsEnvironment.panelCommitStaged, {
    reportFailure: false,
  });
  const panelPullBranch = useAtomCommand(vcsEnvironment.panelPullBranch, { reportFailure: false });
  const panelPushBranch = useAtomCommand(vcsEnvironment.panelPushBranch, { reportFailure: false });
  const panelDeleteBranch = useAtomCommand(vcsEnvironment.panelDeleteBranch, {
    reportFailure: false,
  });
  const panelUndoLatestCommit = useAtomCommand(vcsEnvironment.panelUndoLatestCommit, {
    reportFailure: false,
  });
  const panelRevertCommit = useAtomCommand(vcsEnvironment.panelRevertCommit, {
    reportFailure: false,
  });
  const panelCheckoutCommit = useAtomCommand(vcsEnvironment.panelCheckoutCommit, {
    reportFailure: false,
  });
  const panelCreateBranchFromCommit = useAtomCommand(vcsEnvironment.panelCreateBranchFromCommit, {
    reportFailure: false,
  });
  const panelMergeBranchIntoCurrent = useAtomCommand(vcsEnvironment.panelMergeBranchIntoCurrent, {
    reportFailure: false,
  });
  const panelRebaseCurrentOnto = useAtomCommand(vcsEnvironment.panelRebaseCurrentOnto, {
    reportFailure: false,
  });
  const panelFetchBranch = useAtomCommand(vcsEnvironment.panelFetchBranch, {
    reportFailure: false,
  });
  const panelFetchRemote = useAtomCommand(vcsEnvironment.panelFetchRemote, {
    reportFailure: false,
  });
  const panelFetchAllRemotes = useAtomCommand(vcsEnvironment.panelFetchAllRemotes, {
    reportFailure: false,
  });
  const panelAddRemote = useAtomCommand(vcsEnvironment.panelAddRemote, { reportFailure: false });
  const panelRemoveRemote = useAtomCommand(vcsEnvironment.panelRemoveRemote, {
    reportFailure: false,
  });
  const panelCreateStash = useAtomCommand(vcsEnvironment.panelCreateStash, {
    reportFailure: false,
  });
  const panelApplyStash = useAtomCommand(vcsEnvironment.panelApplyStash, {
    reportFailure: false,
  });
  const panelPopStash = useAtomCommand(vcsEnvironment.panelPopStash, { reportFailure: false });
  const panelDropStash = useAtomCommand(vcsEnvironment.panelDropStash, { reportFailure: false });
  const panelCompare = useAtomQueryRunner(vcsEnvironment.panelCompare, {
    forceRefresh: true,
    reportFailure: false,
  });
  const switchRefCommand = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const runPanelCommand = useCallback(
    async <TInput extends { readonly cwd: string }, TResult>(
      command: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: TInput;
      }) => Promise<AtomCommandResult<TResult, unknown>>,
      input: TInput,
    ): Promise<TResult> => {
      return unwrapPanelCommand(await command({ environmentId, input }));
    },
    [environmentId],
  );

  return useMemo(
    () => ({
      vcs: {
        panelSnapshot: (input: { readonly cwd: string }) =>
          runPanelCommand<typeof input, VcsPanelSnapshotResult>(panelSnapshot, input),
        branchDetails: (input: Parameters<typeof panelBranchDetails>[0]["input"]) =>
          runPanelCommand<typeof input, VcsPanelBranchDetails>(panelBranchDetails, input),
        branchCommits: (input: Parameters<typeof panelBranchCommits>[0]["input"]) =>
          runPanelCommand<typeof input, VcsPanelBranchCommitsResult>(panelBranchCommits, input),
        stashDetails: (input: Parameters<typeof panelStashDetails>[0]["input"]) =>
          runPanelCommand<typeof input, VcsPanelStashDetails>(panelStashDetails, input),
        stageFiles: (input: Parameters<typeof panelStageFiles>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelStageFiles, input),
        unstageFiles: (input: Parameters<typeof panelUnstageFiles>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelUnstageFiles, input),
        discardFiles: (input: Parameters<typeof panelDiscardFiles>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelDiscardFiles, input),
        enrichWorkingTreeFiles: (
          input: Parameters<typeof panelEnrichWorkingTreeFiles>[0]["input"],
        ) =>
          runPanelCommand<typeof input, VcsPanelWorkingTreeFileEnrichmentResult>(
            panelEnrichWorkingTreeFiles,
            input,
          ),
        readFileDiff: (input: Parameters<typeof panelReadFileDiff>[0]["input"]) =>
          runPanelCommand<typeof input, VcsPanelFileDiffResult>(panelReadFileDiff, input),
        commitStaged: (input: Parameters<typeof panelCommitStaged>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelCommitStaged, input),
        pullBranch: (input: Parameters<typeof panelPullBranch>[0]["input"]) =>
          runPanelCommand<typeof input, unknown>(panelPullBranch, input),
        pushBranch: (input: Parameters<typeof panelPushBranch>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelPushBranch, input),
        deleteBranch: (input: Parameters<typeof panelDeleteBranch>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelDeleteBranch, input),
        undoLatestCommit: (input: Parameters<typeof panelUndoLatestCommit>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelUndoLatestCommit, input),
        revertCommit: (input: Parameters<typeof panelRevertCommit>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelRevertCommit, input),
        checkoutCommit: (input: Parameters<typeof panelCheckoutCommit>[0]["input"]) =>
          runPanelCommand<typeof input, VcsSwitchRefResult>(panelCheckoutCommit, input),
        createBranchFromCommit: (
          input: Parameters<typeof panelCreateBranchFromCommit>[0]["input"],
        ) => runPanelCommand<typeof input, unknown>(panelCreateBranchFromCommit, input),
        mergeBranchIntoCurrent: (
          input: Parameters<typeof panelMergeBranchIntoCurrent>[0]["input"],
        ) => runPanelCommand<typeof input, void>(panelMergeBranchIntoCurrent, input),
        rebaseCurrentOnto: (input: Parameters<typeof panelRebaseCurrentOnto>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelRebaseCurrentOnto, input),
        fetchBranch: (input: Parameters<typeof panelFetchBranch>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelFetchBranch, input),
        fetchRemote: (input: Parameters<typeof panelFetchRemote>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelFetchRemote, input),
        fetchAllRemotes: (input: Parameters<typeof panelFetchAllRemotes>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelFetchAllRemotes, input),
        addRemote: (input: Parameters<typeof panelAddRemote>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelAddRemote, input),
        removeRemote: (input: Parameters<typeof panelRemoveRemote>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelRemoveRemote, input),
        createStash: (input: Parameters<typeof panelCreateStash>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelCreateStash, input),
        applyStash: (input: Parameters<typeof panelApplyStash>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelApplyStash, input),
        popStash: (input: Parameters<typeof panelPopStash>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelPopStash, input),
        dropStash: (input: Parameters<typeof panelDropStash>[0]["input"]) =>
          runPanelCommand<typeof input, void>(panelDropStash, input),
        compare: (input: Parameters<typeof panelCompare>[0]["input"]) =>
          runPanelCommand<typeof input, VcsPanelCompareResult>(panelCompare, input),
        switchRef: (input: Parameters<typeof switchRefCommand>[0]["input"]) =>
          runPanelCommand<typeof input, VcsSwitchRefResult>(switchRefCommand, input),
      },
    }),
    [
      panelAddRemote,
      panelApplyStash,
      panelBranchCommits,
      panelBranchDetails,
      panelCheckoutCommit,
      panelCommitStaged,
      panelCompare,
      panelCreateBranchFromCommit,
      panelCreateStash,
      panelDeleteBranch,
      panelDiscardFiles,
      panelDropStash,
      panelEnrichWorkingTreeFiles,
      panelFetchAllRemotes,
      panelFetchBranch,
      panelFetchRemote,
      panelMergeBranchIntoCurrent,
      panelPopStash,
      panelPullBranch,
      panelPushBranch,
      panelReadFileDiff,
      panelRebaseCurrentOnto,
      panelRemoveRemote,
      panelRevertCommit,
      panelSnapshot,
      panelStageFiles,
      panelStashDetails,
      panelUndoLatestCommit,
      panelUnstageFiles,
      runPanelCommand,
      switchRefCommand,
    ],
  );
}

export type SourceControlPanelPresentationState =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string; readonly canCopyError: boolean }
  | { readonly status: "ready"; readonly syncMessage: string | null };

export function resolveSourceControlPanelPresentationState(input: {
  readonly snapshot: VcsPanelSnapshotResult | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly statusPending: boolean;
  readonly statusError: unknown;
}): SourceControlPanelPresentationState {
  if (!input.snapshot) {
    if (input.loading) {
      return {
        status: "loading",
        message: "Loading repository state...",
      };
    }
    return {
      status: "unavailable",
      message:
        input.error ??
        (input.statusError
          ? "Source control status is unavailable."
          : "Source control is unavailable."),
      canCopyError: Boolean(input.error),
    };
  }

  if (input.error) {
    return {
      status: "ready",
      syncMessage: input.error,
    };
  }

  if (input.loading) {
    return {
      status: "ready",
      syncMessage: "Refreshing repository state...",
    };
  }

  if (input.statusError) {
    return {
      status: "ready",
      syncMessage: "Live status sync failed. Showing last loaded repository state.",
    };
  }

  return {
    status: "ready",
    syncMessage: null,
  };
}
