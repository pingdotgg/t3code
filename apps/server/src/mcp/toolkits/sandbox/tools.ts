import {
  AgentctlActionResult,
  AgentctlSandbox,
  AgentctlSandboxManifest,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AgentctlSandboxes from "../../../agentctl/AgentctlSandboxes.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentctlSandboxes.AgentctlSandboxes,
  ],
};
const Name = Schema.Struct({ name: Schema.String });

const SandboxListTool = Tool.make("t3_sandbox_list", {
  ...shared,
  description:
    "List this machine's agentctl Sandboxes, each its own environment once reached, and the manifests to create more from.",
  success: Schema.Struct({
    available: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
    sandboxes: Schema.Array(
      AgentctlSandbox.mapFields((fields) => ({
        name: fields.name,
        phase: fields.phase,
        action: fields.action,
        detail: fields.detail,
        environmentId: fields.environmentId,
        workingDirectory: fields.workingDirectory,
        manifestPath: fields.manifestPath,
      })),
    ),
    manifests: Schema.Array(AgentctlSandboxManifest),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SandboxStartTool = Tool.make("t3_sandbox_start", {
  ...shared,
  description: "Start a stopped Sandbox on its kept disk and wait until it is ready.",
  parameters: Name,
  success: AgentctlActionResult,
}).annotate(Tool.Destructive, false);

const SandboxStopTool = Tool.make("t3_sandbox_stop", {
  ...shared,
  description: "Stop a Sandbox, keeping its disk. Agents running in it stop with it.",
  parameters: Name,
  success: AgentctlActionResult,
}).annotate(Tool.Destructive, true);

const SandboxCreateTool = Tool.make("t3_sandbox_create", {
  ...shared,
  description:
    "Create a Sandbox from a manifest `t3_sandbox_list` returned, under a new name. Returns once agentctl accepts it; provisioning shows in `t3_sandbox_list`.",
  parameters: Schema.Struct({ manifestPath: Schema.String, name: Schema.String }),
  success: AgentctlActionResult,
}).annotate(Tool.Destructive, false);

const SandboxDeleteTool = Tool.make("t3_sandbox_delete", {
  ...shared,
  description:
    "Delete a Sandbox with its disk, including work not pushed, and its project and threads.",
  parameters: Name,
  success: AgentctlActionResult,
}).annotate(Tool.Destructive, true);

export const SandboxToolkit = Toolkit.make(
  SandboxListTool,
  SandboxStartTool,
  SandboxStopTool,
  SandboxCreateTool,
  SandboxDeleteTool,
);
