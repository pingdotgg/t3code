import {
  AuthAccessReadScope,
  AuthAccessWriteScope, // fork: f1 provider account sign-in
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_WS_METHODS,
  type AuthEnvironmentScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * Keep authorization coverage coupled to the RPC group itself. Adding an RPC to
 * `WsRpcGroup` without choosing a scope is a type error instead of a production
 * runtime failure.
 */
export const RPC_REQUIRED_SCOPES = {
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateProvider]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateServer]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverSignalProcess]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  // fork: f1 — signing in/out mutates the environment's provider credentials,
  // an access-control concern. A read-only paired client must not be able to
  // log the host out.
  [WS_METHODS.providerStartSignIn]: AuthAccessWriteScope,
  [WS_METHODS.providerSignOut]: AuthAccessWriteScope,
  // fork: f3 — stopping one agent task operates on a running turn, so it is a
  // thread operation (`orchestration:operate`), not a credential mutation.
  [WS_METHODS.providerStopTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsListEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsReadFile]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSearchContents]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsWriteFile]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsPull]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitRunStackedAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsCreateWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsCreateRef]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsSwitchRef]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsInit]: AuthOrchestrationOperateScope,
  // fork: f4 — source-control panel. Reads are `orchestration:read`; anything
  // that touches the index, the worktree, refs or the stash is
  // `orchestration:operate`, so a read-only paired client can look but not
  // stage, commit, discard or reset.
  [WS_METHODS.workingCopyStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyDiff]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyFileAtRef]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyStagePaths]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyUnstagePaths]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyApplyPatch]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyDiscardPaths]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyRestoreDiscardBackup]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyListDiscardBackups]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyCommitStaged]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyAmendCommit]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyUndoLastCommit]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyLastCommitMessage]: AuthOrchestrationReadScope,
  // fork: f4 AI commit message — a READ: it reads the staged diff and returns
  // text. It never touches the index, the worktree, refs or the stash, so it
  // takes the same scope as its sibling reads.
  [WS_METHODS.workingCopyGenerateCommitMessage]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyLog]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyCommitDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyCommitFileDiff]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyStashList]: AuthOrchestrationReadScope,
  [WS_METHODS.workingCopyStashPush]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyStashApply]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyStashPop]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyStashDrop]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyResolveConflict]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyAbortOperation]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyCherryPick]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyRevertCommit]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyCheckoutCommit]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyResetToCommit]: AuthOrchestrationOperateScope,
  [WS_METHODS.workingCopyTagCommit]: AuthOrchestrationOperateScope,
  // end fork: f4
  [WS_METHODS.reviewGetDiffPreview]: AuthReviewWriteScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthReviewWriteScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalOperateScope,
  [WS_METHODS.previewOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewNavigate]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewResize]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewRefresh]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewReportStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationFocusHost]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}
