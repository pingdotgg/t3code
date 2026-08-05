import {
  AuthAccessReadScope,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentRpcAuthorization,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

export const RPC_REQUIRED_SCOPES = {
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListProviderCommands]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrewarmProviderSession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListSkills]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverExportThreadMarkdown]: AuthOrchestrationReadScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSignalProcess]: AuthOrchestrationOperateScope,
  [WS_METHODS.sidebarGetState]: AuthOrchestrationReadScope,
  [WS_METHODS.sidebarUpdateState]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsSearchEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsReadFile]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsWriteFile]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellRevealInFileManager]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.previewOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewNavigate]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewReportStatus]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewResize]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewRefresh]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewAutomationConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationRespond]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewAutomationFocusHost]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitPull]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitRunStackedAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitListOpenPullRequests]: AuthOrchestrationReadScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitResolveReviewChangesContext]: AuthReviewWriteScope,
  [WS_METHODS.gitPrewarmReviewChangesContext]: AuthReviewWriteScope,
  [WS_METHODS.gitListBranches]: AuthOrchestrationReadScope,
  [WS_METHODS.gitCreateWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitRemoveWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitCreateBranch]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitCheckout]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitInit]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsPull]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsCreateWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsCreateRef]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsSwitchRef]: AuthOrchestrationOperateScope,
  [WS_METHODS.vcsInit]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthReviewWriteScope,
  [WS_METHODS.workflowRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeGitStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeSidebarState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getThreadActivities]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getTurnDiffState]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getFullThreadDiffState]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.replayEvents]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.searchTranscript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getThreadSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export const requiredScopeForRpcMethod = (method: WsRpcMethod): AuthEnvironmentScope =>
  RPC_REQUIRED_SCOPES[method];

const isWsRpcMethod = (method: string): method is WsRpcMethod =>
  Object.hasOwn(RPC_REQUIRED_SCOPES, method);

export const authorizeRpcMethod = (
  scopes: ReadonlySet<AuthEnvironmentScope>,
  method: string,
): Effect.Effect<void, EnvironmentAuthorizationError> => {
  if (!isWsRpcMethod(method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = requiredScopeForRpcMethod(method);
  return scopes.has(requiredScope)
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        }),
      );
};

export const rpcAuthorizationLayer = (
  scopes: ReadonlySet<AuthEnvironmentScope>,
): Layer.Layer<EnvironmentRpcAuthorization> =>
  Layer.succeed(EnvironmentRpcAuthorization, (effect, { rpc }) =>
    authorizeRpcMethod(scopes, rpc._tag).pipe(Effect.andThen(effect)),
  );
