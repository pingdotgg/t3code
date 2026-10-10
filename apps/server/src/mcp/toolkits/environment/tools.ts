import {
  EnvironmentId,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerEnvironmentService from "../../PeerEnvironmentService.ts";

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
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and selected environment preferences. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters. This describes only the environment the thread runs in; use t3_environment_list for the user's other connected environments.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const peer = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PeerEnvironmentService.PeerEnvironmentService,
  ],
};
const EnvironmentListTool = Tool.make("t3_environment_list", {
  ...peer,
  description:
    "List this environment and the user's other connected environments (other machines running T3 Code). Each has an environmentId, label, and status: connected, offline, unauthorized, or incompatible (its server speaks a different protocol version). Other environments are reached through a T3 Code app that is open and connected to both; when none is, only this environment is listed and unavailableReason says why. Pass a connected environmentId to t3_environment_catalog, then to t3_thread_launch, t3_thread_read, and t3_thread_wait.",
  success: PeerEnvironmentService.PeerEnvironmentListResult,
})
  .annotate(Tool.Title, "List connected environments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentCatalogTool = Tool.make("t3_environment_catalog", {
  ...peer,
  description:
    "Read another connected environment's projects and provider instances with their models, as the ids to use when launching a thread there. Project, provider instance, model, and thread ids are per-environment: ids from this environment (t3_project_list, orchestrator_capabilities) do not exist on another one. Get environmentId from t3_environment_list.",
  parameters: Schema.Struct({ environmentId: EnvironmentId }),
  success: PeerEnvironmentService.PeerEnvironmentCatalogResult,
})
  .annotate(Tool.Title, "Read another environment's projects and providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  EnvironmentListTool,
  EnvironmentCatalogTool,
);
