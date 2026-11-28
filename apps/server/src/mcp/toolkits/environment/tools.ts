import {
  ExecutionEnvironmentDescriptor,
  HostPressureLevel,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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
const SettingEntry = Schema.Struct({
  key: Schema.String,
  access: Schema.Literals(["write", "user", "read"]),
  changed: Schema.Boolean,
  locked: Schema.optionalKey(Schema.Boolean),
  value: Schema.optionalKey(Schema.Json),
});
const Machine = Schema.Struct({
  pressure: Schema.Struct({
    memory: HostPressureLevel,
    cpu: HostPressureLevel,
    io: HostPressureLevel,
    disk: HostPressureLevel,
  }).annotate({
    description:
      "Whether work here is stalling, by cause. `none` is fine even when busy; `elevated` slows agents; `severe` stalls or fails them.",
  }),
  cpuCount: Schema.Number,
  cpuUsedPercent: Schema.NullOr(Schema.Number),
  memoryAvailableGb: Schema.Number,
  memoryTotalGb: Schema.Number,
  diskFreeGb: Schema.NullOr(Schema.Number),
});
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and current machine load. To pick the least loaded machine, read each linked environment and compare `machine`. Settings: `t3_settings_read`. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    /** Absent from older servers. */
    machine: Schema.optionalKey(Machine),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SettingsReadTool = Tool.make("t3_settings_read", {
  ...shared,
  description:
    "List environment settings, or read `keys` with values and the JSON Schema `t3_settings_update` accepts. `access`: write = you may change it; user = only the user can; read = read-only.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    keys: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(100))),
  }),
  success: Schema.Struct({
    settings: Schema.Array(SettingEntry),
    schema: Schema.optionalKey(Schema.Json),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SettingsUpdateTool = Tool.make("t3_settings_update", {
  ...shared,
  description:
    "Change environment settings whose access is write. Live full-access or default caller thread only. Omitted keys stay. For an object or array, send its whole new value.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    settings: Schema.Record(Schema.String, Schema.Json).annotate({
      description: "Key to new value, shaped as `t3_settings_read` returns in `schema`.",
    }),
  }),
  success: Schema.Struct({ settings: Schema.Array(SettingEntry) }),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  SettingsReadTool,
  SettingsUpdateTool,
);
