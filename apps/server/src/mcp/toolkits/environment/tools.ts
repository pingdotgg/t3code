import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  CustomModelSetting,
  DelegationCandidate,
  DelegationTierId,
  DelegationTiers,
  EnvironmentConnectReachabilityCause,
  ExecutionEnvironmentDescriptor,
  IdleCompactionMode,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  StorageCleanupReport,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as CloudLink from "../../../cloud/CloudLink.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProviderInstanceView = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  accentColor: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  customModels: Schema.Array(CustomModelSetting),
});
const PreferenceFields = {
  completionAudio: ServerSettings.fields.completionAudio,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
  sidebarAutoSettleAfterDays: ServerSettings.fields.sidebarAutoSettleAfterDays,
  sidebarAutoSettleOnMerge: ServerSettings.fields.sidebarAutoSettleOnMerge,
  t3AgentInstructions: ServerSettings.fields.t3AgentInstructions,
  t3ContextHandoff: ServerSettings.fields.t3ContextHandoff,
  t3SideChatContext: ServerSettings.fields.t3SideChatContext,
  t3RestartNote: ServerSettings.fields.t3RestartNote,
  t3WakeOnDelegateFinished: ServerSettings.fields.t3WakeOnDelegateFinished,
  t3WakeOnDelegateQuestion: ServerSettings.fields.t3WakeOnDelegateQuestion,
  t3WakeOnPullRequestUpdate: ServerSettings.fields.t3WakeOnPullRequestUpdate,
  t3GoalContinuation: ServerSettings.fields.t3GoalContinuation,
  agentMessagePolicy: ServerSettings.fields.agentMessagePolicy,
  claudeInstructionFiles: ServerSettings.fields.claudeInstructionFiles,
  claudeAutoMemory: ServerSettings.fields.claudeAutoMemory,
  claudeGitContext: ServerSettings.fields.claudeGitContext,
  claudeSkillList: ServerSettings.fields.claudeSkillList,
  claudeContextLists: ServerSettings.fields.claudeContextLists,
  claudeHooks: ServerSettings.fields.claudeHooks,
  sidebarAutoSettleKeepPullRequests: ServerSettings.fields.sidebarAutoSettleKeepPullRequests,
  pullRequestMergeMethod: ServerSettings.fields.pullRequestMergeMethod,
  branchNamingMode: ServerSettings.fields.branchNamingMode,
  reviewGuidesEnabled: ServerSettings.fields.reviewGuidesEnabled,
  defaultAutoPull: ServerSettings.fields.defaultAutoPull,
  removeAgentCreditsOnMerge: ServerSettings.fields.removeAgentCreditsOnMerge,
  worktreeSubmodules: ServerSettings.fields.worktreeSubmodules,
  favorites: ServerSettings.fields.favorites,
  providerModelPreferences: ServerSettings.fields.providerModelPreferences,
  defaultModelSelection: ServerSettings.fields.defaultModelSelection,
  textGenerationModelSelection: ServerSettings.fields.textGenerationModelSelection,
  sourceControlWriterModelSelection: ServerSettings.fields.sourceControlWriterModelSelection,
  reviewGuideModelSelection: ServerSettings.fields.reviewGuideModelSelection,
  idleCompaction: IdleCompactionMode,
  snoozeLimitedThreads: ServerSettings.fields.snoozeLimitedThreads,
  autoResumeLimitedThreads: ServerSettings.fields.autoResumeLimitedThreads,
  continueThreadsAfterServerUpdate: ServerSettings.fields.continueThreadsAfterServerUpdate,
  responseStreamingMode: ServerSettings.fields.responseStreamingMode,
  defaultRuntimeMode: ServerSettings.fields.defaultRuntimeMode,
  delegationTiers: DelegationTiers,
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceView),
};
// Compact candidate input: provider `options` stay a Settings-UI concern, so
// the schema does not embed the option-selection union.
const DelegationTierCandidateInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  minHeadroomPercent: DelegationCandidate.fields.minHeadroomPercent,
});
const DelegationTierChange = Schema.Struct({
  tier: DelegationTierId,
  before: DelegationTiers.fields.small,
  after: DelegationTiers.fields.small,
});
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    CloudLink.CloudLink,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`. Completion audio defaults apply to future top-level threads; Sound needs a web/desktop client. Also model `favorites`/`providerModelPreferences`, `idleCompaction`, `providerInstances`, and `connect` (null if unknown; Connect changes stay in Settings).",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    connect: Schema.NullOr(
      Schema.Struct({
        linked: Schema.Boolean,
        linkRevoked: Schema.Boolean,
        managedTunnelActive: Schema.Boolean,
        publishAgentActivity: Schema.Boolean,
        holdWebhooksWhileOffline: Schema.Boolean,
        reachability: Schema.NullOr(
          Schema.Struct({
            status: Schema.Literals(["reachable", "unreachable"]),
            checkedAt: Schema.String,
            cause: Schema.optionalKey(EnvironmentConnectReachabilityCause),
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    ProviderRegistry.ProviderRegistry,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ],
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it. `completionAudio` changes future defaults only; use `t3_completion_audio_bulk_off` for existing threads. Model preference ops are incremental; provider instance ids come from `orchestrator_capabilities`. `null` resets a model default. Global model defaults apply where a project sets none. `snoozeLimitedThreads` never resumes threads. `defaultRuntimeMode` can only be lowered; raise it in Settings. `pullRequestMergeMethod` `null` uses each device's last selected method. `setDelegationTier` replaces one tier's candidates (null clears); their minimum headroom can only rise. Per-project values: `t3_project_settings_update`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    completionAudio: ServerSettingsPatch.fields.completionAudio,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    sidebarAutoSettleAfterDays: ServerSettingsPatch.fields.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: ServerSettingsPatch.fields.sidebarAutoSettleOnMerge,
    t3AgentInstructions: ServerSettingsPatch.fields.t3AgentInstructions,
    t3ContextHandoff: ServerSettingsPatch.fields.t3ContextHandoff,
    t3SideChatContext: ServerSettingsPatch.fields.t3SideChatContext,
    t3RestartNote: ServerSettingsPatch.fields.t3RestartNote,
    t3WakeOnDelegateFinished: ServerSettingsPatch.fields.t3WakeOnDelegateFinished,
    t3WakeOnDelegateQuestion: ServerSettingsPatch.fields.t3WakeOnDelegateQuestion,
    t3WakeOnPullRequestUpdate: ServerSettingsPatch.fields.t3WakeOnPullRequestUpdate,
    t3GoalContinuation: ServerSettingsPatch.fields.t3GoalContinuation,
    agentMessagePolicy: ServerSettingsPatch.fields.agentMessagePolicy,
    claudeInstructionFiles: ServerSettingsPatch.fields.claudeInstructionFiles,
    claudeAutoMemory: ServerSettingsPatch.fields.claudeAutoMemory,
    claudeGitContext: ServerSettingsPatch.fields.claudeGitContext,
    claudeSkillList: ServerSettingsPatch.fields.claudeSkillList,
    claudeContextLists: ServerSettingsPatch.fields.claudeContextLists,
    claudeHooks: ServerSettingsPatch.fields.claudeHooks,
    sidebarAutoSettleKeepPullRequests: ServerSettingsPatch.fields.sidebarAutoSettleKeepPullRequests,
    pullRequestMergeMethod: ServerSettingsPatch.fields.pullRequestMergeMethod,
    branchNamingMode: ServerSettingsPatch.fields.branchNamingMode,
    defaultAutoPull: ServerSettingsPatch.fields.defaultAutoPull,
    removeAgentCreditsOnMerge: ServerSettingsPatch.fields.removeAgentCreditsOnMerge,
    worktreeSubmodules: ServerSettingsPatch.fields.worktreeSubmodules,
    setModelFavorites: ServerSettingsPatch.fields.setModelFavorites,
    setModelsHidden: ServerSettingsPatch.fields.setModelsHidden,
    setProviderModelOrder: ServerSettingsPatch.fields.setProviderModelOrder,
    setProviderModelDefault: ServerSettingsPatch.fields.setProviderModelDefault,
    defaultModelSelection: ServerSettingsPatch.fields.defaultModelSelection,
    textGenerationModelSelection: ServerSettingsPatch.fields.textGenerationModelSelection,
    sourceControlWriterModelSelection: ServerSettingsPatch.fields.sourceControlWriterModelSelection,
    reviewGuideModelSelection: ServerSettingsPatch.fields.reviewGuideModelSelection,
    idleCompaction: ServerSettingsPatch.fields.idleCompaction,
    snoozeLimitedThreads: ServerSettingsPatch.fields.snoozeLimitedThreads,
    autoResumeLimitedThreads: ServerSettingsPatch.fields.autoResumeLimitedThreads,
    continueThreadsAfterServerUpdate: ServerSettingsPatch.fields.continueThreadsAfterServerUpdate,
    responseStreamingMode: ServerSettingsPatch.fields.responseStreamingMode,
    defaultRuntimeMode: ServerSettingsPatch.fields.defaultRuntimeMode,
    setDelegationTier: Schema.optionalKey(
      Schema.Struct({
        tier: DelegationTierId,
        candidates: Schema.NullOr(Schema.Array(DelegationTierCandidateInput)),
      }),
    ),
  }),
  success: Schema.Struct({
    ...PreferenceFields,
    delegationTierChange: Schema.optionalKey(DelegationTierChange),
  }),
}).annotate(Tool.Destructive, true);
const ProviderInstanceUpdateTool = Tool.make("t3_provider_instance_update", {
  ...shared,
  description:
    "Edit one provider instance: `customModels` replaces its list; `displayName` and `accentColor` set or clear (null). Ids: `t3_environment_read` `providerInstances`. Enabling, executables, env, credentials, and login stay in Settings.",
  parameters: Schema.Struct({
    instanceId: ProviderInstanceId,
    customModels: Schema.optionalKey(Schema.Array(CustomModelSetting)),
    displayName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    accentColor: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  success: ProviderInstanceView,
}).annotate(Tool.Destructive, true);
const keybindings = {
  ...shared,
  dependencies: [...shared.dependencies, Keybindings.Keybindings],
  success: ServerUpsertKeybindingResult,
};
const KeybindingsListTool = Tool.make("t3_keybindings_list", {
  ...keybindings,
  description:
    "List effective keybindings and config issues. `t3_keybinding_remove` needs a custom rule's exact `key`, `command`, and `when`.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
// The contract's keybinding command enum costs ~1.7KB of JSON schema per
// occurrence, so the advertised parameters take any non-empty string and the
// handlers validate each command against the contract schema instead.
const keybindingRuleParams = {
  key: ServerUpsertKeybindingInput.fields.key,
  command: TrimmedNonEmptyString,
  when: ServerUpsertKeybindingInput.fields.when,
};
const KeybindingUpsertTool = Tool.make("t3_keybinding_upsert", {
  ...keybindings,
  description:
    "Add or replace one custom keybinding. `command` is an id from `t3_keybindings_list` or `script.<id>.run`; `replace` names the rule to swap. Returns effective keybindings.",
  parameters: Schema.Struct({
    ...keybindingRuleParams,
    replace: Schema.optional(Schema.Struct(keybindingRuleParams)),
  }),
}).annotate(Tool.Destructive, true);
const KeybindingRemoveTool = Tool.make("t3_keybinding_remove", {
  ...keybindings,
  description:
    "Remove the custom keybinding with exactly this `key`, `command` (an id from `t3_keybindings_list`), and `when`. Defaults cannot be removed. Returns effective keybindings.",
  parameters: Schema.Struct(keybindingRuleParams),
}).annotate(Tool.Destructive, true);
const StorageReportTool = Tool.make("t3_environment_storage_report", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    StorageCleanup.StorageCleanup,
    DatabaseStorage.DatabaseStorage,
  ],
  description:
    "Summarize storage: database size, reclaimable space, and the latest cleanup totals (null if not measured). Read-only.",
  success: Schema.Struct({
    database: Schema.NullOr(
      Schema.Struct({
        databaseBytes: Schema.Number,
        reclaimableBytes: Schema.Number,
        incrementalVacuumEnabled: Schema.Boolean,
        compactionRecommended: Schema.Boolean,
      }),
    ),
    lastCleanup: Schema.NullOr(
      Schema.Struct({
        trigger: StorageCleanupReport.fields.trigger,
        startedAt: Schema.String,
        finishedAt: Schema.String,
        counts: StorageCleanupReport.fields.counts,
        bytesFreed: Schema.Number,
        entryCount: Schema.Number,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  ProviderInstanceUpdateTool,
  KeybindingsListTool,
  KeybindingUpsertTool,
  KeybindingRemoveTool,
  StorageReportTool,
);
