import type {
  EnvironmentId,
  VcsPanelBranchDetails,
  VcsPanelCommitFilesResult,
  VcsPanelFileDiffResult,
  VcsPanelSnapshotInput,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { vcsEnvironment } from "../../state/vcs";
import { VersionControlCommandInterrupted } from "./versionControlRequest";

export { VersionControlCommandInterrupted } from "./versionControlRequest";

async function unwrapPanelCommand<TResult>(
  result: AtomCommandResult<TResult, unknown>,
): Promise<TResult> {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new VersionControlCommandInterrupted();
  throw squashAtomCommandFailure(result);
}

export function useVersionControlPanelApi(environmentId: EnvironmentId) {
  const panelSnapshot = useAtomQueryRunner(vcsEnvironment.panelSnapshot, {
    refresh: true,
    reportFailure: false,
  });
  const retryPanelCommitFiles = useAtomQueryRunner(vcsEnvironment.panelCommitFiles, {
    reportFailure: false,
    refresh: true,
  });
  const panelCommitFiles = useAtomQueryRunner(vcsEnvironment.panelCommitFiles, {
    reportFailure: false,
  });
  const panelBranchDetails = useAtomQueryRunner(vcsEnvironment.panelBranchDetails, {
    refresh: true,
    reportFailure: false,
  });
  const panelStashDetails = useAtomQueryRunner(vcsEnvironment.panelStashDetails, {
    refresh: true,
    reportFailure: false,
  });
  const panelReadFileDiff = useAtomQueryRunner(vcsEnvironment.panelReadFileDiff, {
    refresh: true,
    reportFailure: false,
  });
  const panelEnrichWorkingTreeFiles = useAtomQueryRunner(
    vcsEnvironment.panelEnrichWorkingTreeFiles,
    {
      refresh: true,
      reportFailure: false,
    },
  );

  const panelStageFiles = useAtomCommand(vcsEnvironment.panelStageFiles, {
    reportFailure: false,
  });
  const panelDiscardFiles = useAtomCommand(vcsEnvironment.panelDiscardFiles, {
    reportFailure: false,
  });
  const panelCommitStaged = useAtomCommand(vcsEnvironment.panelCommitStaged, {
    reportFailure: false,
  });
  const panelPullBranch = useAtomCommand(vcsEnvironment.panelPullBranch, {
    reportFailure: false,
  });
  const panelPushBranch = useAtomCommand(vcsEnvironment.panelPushBranch, {
    reportFailure: false,
  });
  const panelDeleteBranch = useAtomCommand(vcsEnvironment.panelDeleteBranch, {
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
  const panelAddRemote = useAtomCommand(vcsEnvironment.panelAddRemote, {
    reportFailure: false,
  });
  const panelRemoveRemote = useAtomCommand(vcsEnvironment.panelRemoveRemote, {
    reportFailure: false,
  });
  const panelCreateStash = useAtomCommand(vcsEnvironment.panelCreateStash, {
    reportFailure: false,
  });
  const panelApplyStash = useAtomCommand(vcsEnvironment.panelApplyStash, {
    reportFailure: false,
  });
  const panelPopStash = useAtomCommand(vcsEnvironment.panelPopStash, {
    reportFailure: false,
  });
  const panelDropStash = useAtomCommand(vcsEnvironment.panelDropStash, {
    reportFailure: false,
  });

  const runPanelCommand = useCallback(
    async <TInput extends { readonly cwd: string }, TResult>(
      command: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: TInput;
      }) => Promise<AtomCommandResult<TResult, unknown>>,
      input: TInput,
    ): Promise<TResult> => unwrapPanelCommand(await command({ environmentId, input })),
    [environmentId],
  );

  return useMemo(
    () => ({
      snapshot: (input: VcsPanelSnapshotInput) =>
        runPanelCommand<typeof input, VcsPanelSnapshotResult>(panelSnapshot, input),
      commitFiles: (input: Parameters<typeof panelCommitFiles>[0]["input"], retry = false) =>
        runPanelCommand<typeof input, VcsPanelCommitFilesResult>(
          retry ? retryPanelCommitFiles : panelCommitFiles,
          input,
        ),
      branchDetails: (input: Parameters<typeof panelBranchDetails>[0]["input"]) =>
        runPanelCommand<typeof input, VcsPanelBranchDetails>(panelBranchDetails, {
          ...input,
          deferCommitFiles: true,
        }),
      stashDetails: (input: Parameters<typeof panelStashDetails>[0]["input"]) =>
        runPanelCommand<typeof input, VcsPanelStashDetails>(panelStashDetails, input),
      readFileDiff: (input: Parameters<typeof panelReadFileDiff>[0]["input"]) =>
        runPanelCommand<typeof input, VcsPanelFileDiffResult>(panelReadFileDiff, input),
      enrichWorkingTreeFiles: (input: Parameters<typeof panelEnrichWorkingTreeFiles>[0]["input"]) =>
        runPanelCommand<typeof input, VcsPanelWorkingTreeFileEnrichmentResult>(
          panelEnrichWorkingTreeFiles,
          input,
        ),
      stageFiles: (input: Parameters<typeof panelStageFiles>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelStageFiles, input),
      discardFiles: (input: Parameters<typeof panelDiscardFiles>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelDiscardFiles, input),
      commitStaged: (input: Parameters<typeof panelCommitStaged>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelCommitStaged, input),
      pullBranch: (input: Parameters<typeof panelPullBranch>[0]["input"]) =>
        runPanelCommand<typeof input, unknown>(panelPullBranch, input),
      pushBranch: (input: Parameters<typeof panelPushBranch>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelPushBranch, input),
      deleteBranch: (input: Parameters<typeof panelDeleteBranch>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelDeleteBranch, input),
      mergeBranchIntoCurrent: (input: Parameters<typeof panelMergeBranchIntoCurrent>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelMergeBranchIntoCurrent, input),
      rebaseCurrentOnto: (input: Parameters<typeof panelRebaseCurrentOnto>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelRebaseCurrentOnto, input),
      fetchBranch: (input: Parameters<typeof panelFetchBranch>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelFetchBranch, input),
      fetchRemote: (input: Parameters<typeof panelFetchRemote>[0]["input"]) =>
        runPanelCommand<typeof input, void>(panelFetchRemote, input),
      fetchAllRemotes: (input: Parameters<typeof panelFetchAllRemotes>[0]["input"]) =>
        runPanelCommand<typeof input, boolean>(panelFetchAllRemotes, input),
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
    }),
    [
      panelAddRemote,
      panelApplyStash,
      panelCommitFiles,
      retryPanelCommitFiles,
      panelBranchDetails,
      panelCommitStaged,
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
      panelSnapshot,
      panelStageFiles,
      panelStashDetails,
      runPanelCommand,
    ],
  );
}
