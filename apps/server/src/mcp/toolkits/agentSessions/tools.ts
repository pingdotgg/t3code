import {
  AgentSessionImportInput,
  AgentSessionImportResult,
  AgentSessionScanResult,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};

const AgentSessionsScanTool = Tool.make("t3_agent_sessions_scan", {
  ...shared,
  description:
    "Find local Claude Code, Codex and enabled Pi project histories to import at any time. Returns paths, existing project IDs, sources and counts. Register a missing project with t3_project_create, then use t3_agent_sessions_import. A truncated scan may omit histories.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: AgentSessionScanResult,
  dependencies: [...shared.dependencies, AgentSessionScanner.AgentSessionScanner],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentSessionsImportTool = Tool.make("t3_agent_sessions_import", {
  ...shared,
  description:
    "Import a registered project's recent Claude Code, Codex and enabled Pi threads without onboarding. Use the project ID and path from t3_agent_sessions_scan as projectId and expectedWorkspaceRoot. Imports up to 100 conversations active in the last 30 days per call; repeat for remaining history. Completed imports are skipped. Returns counts; find imported threads with t3_thread_list. Requires full access.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...AgentSessionImportInput.fields,
  }),
  success: AgentSessionImportResult,
  dependencies: [...shared.dependencies, AgentSessionImporter.AgentSessionImporter],
}).annotate(Tool.Destructive, false);

export const AgentSessionsToolkit = Toolkit.make(AgentSessionsScanTool, AgentSessionsImportTool);
