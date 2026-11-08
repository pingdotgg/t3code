import {
  OrchestratorMcpFailure,
  SandboxHostedPortResult,
  WorktreeMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import {
  PrepareSandboxBranchTool,
  RunSandboxSetupTool,
} from "../../../workspace/CloudSandboxWorkspaceTools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

const PreviewShareTool = Tool.make("preview_share", {
  description:
    "Share a localhost web server in this managed sandbox through a token-protected provider URL. Returns a sensitive URL; do not log it. Sharing is separate from the T3 control server.",
  parameters: Schema.Struct({
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  success: SandboxHostedPortResult,
  failure: Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

/** Advertised only on a server that starts with managed-cloud.json. See McpHttpServer.layerManagedSandboxToolkit. */
export const ManagedSandboxToolkit = Toolkit.make(
  PrepareSandboxBranchTool.addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .addDependency(WorktreeMcpService.WorktreeMcpService),
  RunSandboxSetupTool.addDependency(McpInvocationContext.McpInvocationContext)
    .addDependency(ThreadManagementService.ThreadManagementService)
    .addDependency(WorktreeMcpService.WorktreeMcpService),
  PreviewShareTool,
);
