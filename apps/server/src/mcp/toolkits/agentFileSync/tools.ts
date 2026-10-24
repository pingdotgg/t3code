import {
  AgentFileSyncScope,
  AgentFileSyncCatalog,
  AgentFileSyncExportInput,
  AgentFileSyncBundle,
  AgentFileSyncPreviewInput,
  AgentFileSyncPreview,
  AgentFileSyncSubscribeInput,
  AgentFileSyncLinks,
  AgentFileSyncManageInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as AgentFileSync from "../../../agentFileSync/AgentFileSync.ts";
import * as AgentFileSyncLinksService from "../../../agentFileSync/AgentFileSyncLinks.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    AgentFileSync.AgentFileSync,
    Environment.ServerEnvironment,
    AgentFileSyncLinksService.AgentFileSyncLinks,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
const catalog = Tool.make("t3_agent_files_list", {
  ...shared,
  parameters: AgentFileSyncScope,
  success: AgentFileSyncCatalog,
  description:
    "List personal skills and instruction sections in this environment. Pass cwd for a registered project. Imported instruction blocks are excluded from sources.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const exportFiles = Tool.make("t3_agent_files_export", {
  ...shared,
  parameters: AgentFileSyncExportInput,
  success: AgentFileSyncBundle,
  description:
    "Read the selected complete skill folders and AGENTS.md/CLAUDE.md sections on this environment. Only the selected folders and sections are included.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const preview = Tool.make("t3_agent_files_preview", {
  ...shared,
  parameters: AgentFileSyncPreviewInput,
  success: AgentFileSyncPreview,
  description:
    "Preview a selected bundle on this destination before enabling automatic sync. Returns revisions required for setup.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const list = Tool.make("t3_agent_files_sync_list", {
  ...shared,
  parameters: Tool.EmptyParams,
  success: AgentFileSyncLinks,
  description:
    "List saved sync subscriptions on this destination, including paused conflicts. File contents are omitted. Sync is relayed while a T3 client connects both environments.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const subscribe = Tool.make("t3_agent_files_sync_start", {
  ...shared,
  parameters: AgentFileSyncSubscribeInput,
  success: Schema.Void,
  description:
    "Apply a reviewed bundle and save its one-way automatic sync subscription on this destination. Requires the revisions from preview. Skill folders are replaced; instruction sections use managed blocks. Needs full access.",
}).annotate(Tool.Destructive, true);
const manage = Tool.make("t3_agent_files_sync_manage", {
  ...shared,
  parameters: AgentFileSyncManageInput,
  success: Schema.Void,
  description:
    "Pause, resume, or remove a destination's automatic sync subscription. Remove keeps the current files. Resume requires conflicting managed content to be repaired first. Needs full access.",
}).annotate(Tool.Destructive, true);
export const AgentFileSyncToolkit = Toolkit.make(
  catalog,
  exportFiles,
  preview,
  list,
  subscribe,
  manage,
);
