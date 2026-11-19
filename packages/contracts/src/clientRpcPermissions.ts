import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  // Installing Ollama and pulling models download gigabytes and change the agents on offer.
  [WS_METHODS.ollamaInstall]: AuthProvidersManageScope,
  [WS_METHODS.ollamaStart]: AuthProvidersManageScope,
  [WS_METHODS.ollamaPullModel]: AuthProvidersManageScope,
  [WS_METHODS.ollamaDeleteModel]: AuthProvidersManageScope,
  [WS_METHODS.ollamaSetAgentIntegration]: AuthProvidersManageScope,
  // Game editors: installs run vendor installers; commands and restores change the open project.
  [WS_METHODS.gameDevInstall]: AuthProvidersManageScope,
  [WS_METHODS.gameDevLocate]: AuthSettingsWriteScope,
  [WS_METHODS.gameDevOpenProject]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevBindSession]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.gameDevCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevResolveApproval]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevCheckpointCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevCheckpointRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevAssetImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.gameDevSetForgeGuiKey]: AuthProvidersManageScope,
  [WS_METHODS.gameDevTestForgeGui]: AuthProvidersManageScope,
  // Supercharge and /improve start agent turns.
  [WS_METHODS.superchargeConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.superchargeStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.improveStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.improveRetry]: AuthOrchestrationOperateScope,
  [WS_METHODS.improveDismiss]: AuthOrchestrationOperateScope,
  // Runtime updates download and run provider executables.
  [WS_METHODS.providerRuntimesUpdateSettings]: AuthProvidersManageScope,
  [WS_METHODS.providerRuntimesCheckNow]: AuthProvidersManageScope,
  [WS_METHODS.providerRuntimesRestore]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingSetSource]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingSetEndpoint]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingCreateGrant]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingUpdateGrant]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingRevokeGrant]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingRotateGrant]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingRedeem]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingRefreshConnection]: AuthProvidersManageScope,
  [WS_METHODS.usageSharingRemoveConnection]: AuthProvidersManageScope,
  // Vault notes reach every agent that uses the vault.
  [WS_METHODS.memoryVaultsUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.memoryVaultsManage]: AuthSettingsWriteScope,
  [WS_METHODS.memoryVaultsWriteFile]: AuthSettingsWriteScope,
  [WS_METHODS.memoryVaultsSelect]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
