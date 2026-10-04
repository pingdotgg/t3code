import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  CustomModelSetting,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
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
};
// Plain strings keep the published schema small; the handler decodes the real contract.
const KeybindingTarget = Schema.Struct({
  key: Schema.String,
  command: Schema.String,
  when: Schema.optional(Schema.NullOr(Schema.String)),
});
const KeybindingRuleText = Schema.Struct({
  key: Schema.String,
  command: Schema.String,
  when: Schema.NullOr(Schema.String),
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
    Keybindings.Keybindings,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected environment preferences. include=['settings'] adds the full server settings (the shape t3_environment_preferences_update accepts in settings) with credentials redacted; it needs full access because settings hold host paths. include=['keybindings'] adds the effective keybindings as key/command/when text. Theme and other per-device settings live in each client and are not here. Provider status and quota are in t3_provider_status; models are in orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  parameters: Schema.Struct({
    include: Schema.optional(Schema.Array(Schema.Literals(["settings", "keybindings"]))),
  }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    keybindings: Schema.optional(Schema.Array(KeybindingRuleText)),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide settings through normal settings persistence and notifications. Requires a live full-access/default calling thread or a full-access client. Omitted fields are preserved; empty customInstructions clears them. settings takes a patch of only the keys you change, shaped like t3_environment_read include=['settings'] (durations in milliseconds, nested objects merge; echoing the whole read back is rejected because some fields are read-only); credential fields (bitbucket, usageLimitSources, cursorKeychainUsageEnabled, providers.antigravity.apiKey, providers.opencode.serverPassword) and providerInstances/deviceHosts are rejected and stay in the Settings UI. providerInstance enables/disables one provider instance or replaces its custom models. keybinding upserts (optionally replacing an existing rule) or removes one rule matched by exact key/command/when text, in its own call; removing a command's last custom rule restores its default.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    providerInstance: Schema.optional(
      Schema.Struct({
        instanceId: ProviderInstanceId,
        enabled: Schema.optional(Schema.Boolean),
        customModels: Schema.optional(Schema.Array(CustomModelSetting)),
      }),
    ),
    keybinding: Schema.optional(
      Schema.Struct({
        action: Schema.Literals(["upsert", "remove"]),
        ...KeybindingTarget.fields,
        replace: Schema.optional(KeybindingTarget),
      }),
    ),
  }),
  success: Schema.Struct({
    ...PreferenceFields,
    updated: Schema.Array(Schema.String),
    /** The command's effective rules after a keybinding change. */
    keybindings: Schema.optional(Schema.Array(KeybindingRuleText)),
  }),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
