import type { ServerSettings } from "@t3tools/contracts";

/**
 * `user`: only the user changes it (secrets, access, widening what agents may do, text other models obey).
 * `read`: server-maintained, owned by another tool, or file-edit only.
 * `hidden`: legacy mirrors and derived values; their canonical key is listed instead.
 */
export type AgentSettingAccess = "write" | "user" | "read" | "hidden";

export const AGENT_SETTING_ACCESS = {
  favorites: "write",
  providerModelPreferences: "write",
  worktreeCleanup: "user",
  storageCleanup: "user",
  worktreesDirectory: "user",
  fastWorktreeCheckout: "write",
  previousWorktreesDirectories: "read",
  responseStreamingMode: "write",
  enableProviderUpdateChecks: "write",
  continueThreadsAfterServerUpdate: "write",
  keepAwakeWhileAgentsWork: "write",
  requireConnectDeviceApproval: "user",
  enableAgentBrowserAccess: "user",
  enablePreviewTunnel: "user",
  cloudSpeechCredentials: "user",
  speechModelId: "write",
  speechAcceleration: "write",
  speechModelUnloadTimeout: "write",
  speechProjectCustomWords: "write",
  speechPostProcessingModelSelection: "write",
  projectAgentBrowserAccessOverrides: "hidden",
  defaultAutoPull: "write",
  defaultProjectScripts: "user",
  projectScriptOverrides: "hidden",
  projectAutoPullOverrides: "hidden",
  defaultModelSelection: "write",
  fallbackModelSelection: "write",
  defaultRuntimeMode: "user",
  projectSettingsOverrides: "user",
  projectSettingsFolded: "hidden",
  enableAgentDeviceAccess: "user",
  enableDeviceSupport: "user",
  deviceOnboardingCompleted: "write",
  deviceHosts: "user",
  easDeviceHosts: "user",
  simlockDeviceHosts: "user",
  simlockDeviceHostsEnabled: "user",
  sidebarAutoSettleAfterDays: "write",
  compactIdleThreads: "hidden",
  idleCompaction: "write",
  snoozeLimitedThreads: "write",
  autoResumeLimitedThreads: "write",
  snoozePresets: "write",
  hiddenThreadTags: "write",
  hideTaggedThreads: "write",
  guestSharingEnabled: "user",
  linkedEnvironmentsEnabled: "user",
  workflowsEnabled: "user",
  promptSuggestionsEnabled: "write",
  sidebarAutoSettleKeepPullRequests: "write",
  sidebarAutoSettleOnMerge: "write",
  backgroundActivity: "write",
  automaticGitFetchInterval: "hidden",
  providerHealthRefreshInterval: "hidden",
  backgroundActivityProfile: "hidden",
  defaultTheme: "read",
  defaultThemeSetAt: "hidden",
  defaultAppearance: "read",
  defaultAppearanceSetAt: "hidden",
  environmentIcon: "write",
  defaultThreadEnvMode: "write",
  newWorktreesStartFromOrigin: "write",
  worktreeSubmodules: "write",
  addProjectBaseDirectory: "write",
  ghqCloneLayout: "write",
  textGenerationModelSelection: "write",
  threadTitleInstructions: "user",
  branchNamingMode: "write",
  branchNamePrefix: "write",
  branchNameInstructions: "user",
  removeAgentCreditsOnMerge: "write",
  sourceControlWritingStyle: "user",
  sourceControlWriterModelSelection: "write",
  reviewGuidesEnabled: "user",
  reviewGuideModelSelection: "write",
  reviewGuideInstructions: "user",
  pullRequestMergeMethod: "write",
  providerInstances: "user",
  observability: "user",
  sourceControlHosts: "user",
  offeredSourceControlProviders: "write",
  usageLimitSources: "user",
  textGenerators: "user",
  secretProviders: "user",
  usageHistoryRetentionDays: "user",
  usagePriceOverrides: "write",
  usageModelAliases: "write",
  usageModelFilter: "read",
  agentFeedback: "hidden",
} as const satisfies Record<keyof ServerSettings, AgentSettingAccess>;

export type AgentSettingKey = keyof typeof AGENT_SETTING_ACCESS;
export type AgentWritableSettingKey = {
  [Key in AgentSettingKey]: (typeof AGENT_SETTING_ACCESS)[Key] extends "write" ? Key : never;
}[AgentSettingKey];

export const agentSettingAccess = (key: string): AgentSettingAccess | undefined =>
  Object.hasOwn(AGENT_SETTING_ACCESS, key)
    ? AGENT_SETTING_ACCESS[key as AgentSettingKey]
    : undefined;

export const LISTED_SETTING_KEYS = (Object.keys(AGENT_SETTING_ACCESS) as AgentSettingKey[]).filter(
  (key) => AGENT_SETTING_ACCESS[key] !== "hidden",
);

export const AGENT_WRITABLE_SETTING_KEYS = LISTED_SETTING_KEYS.filter(
  (key): key is AgentWritableSettingKey => AGENT_SETTING_ACCESS[key] === "write",
);
