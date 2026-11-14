import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
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
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    HostResources.HostResources,
  ],
};
const Percent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const GiB = Schema.Number;
// Rounded and trimmed: agents compare machines with it, and each read costs them tokens.
const MachineResources = Schema.Struct({
  cpu: Schema.Struct({
    usedPercent: Schema.NullOr(Percent),
    cores: Schema.Int,
    model: Schema.optionalKey(Schema.String),
    load1m: Schema.optionalKey(Schema.Number),
  }),
  memory: Schema.Struct({ availableGiB: GiB, totalGiB: GiB }),
  swap: Schema.optionalKey(Schema.Struct({ usedGiB: GiB, totalGiB: GiB })),
  disks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        mount: Schema.String,
        freeGiB: GiB,
        totalGiB: GiB,
        holds: Schema.optionalKey(Schema.Array(Schema.Literals(["t3Home", "worktrees"]))),
      }),
    ),
  ),
  disksUnavailable: Schema.optionalKey(Schema.String),
  gpus: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        usedPercent: Schema.optionalKey(Percent),
        memoryFreeGiB: Schema.optionalKey(GiB),
        memoryTotalGiB: Schema.optionalKey(GiB),
      }),
    ),
  ),
  gpusUnavailable: Schema.optionalKey(Schema.String),
});
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read a machine's identity, preferences, and free CPU, memory, disk and GPU now. To pick a machine, read each linked environment; no SSH `df`/`free`. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    // Optional: a linked server that predates it still decodes.
    machine: Schema.optionalKey(MachineResources),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
