import {
  InstructionAgentsResult,
  InstructionListResult,
  InstructionReadInput,
  InstructionReadResult,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as InstructionCatalog from "../../../instructions/InstructionCatalog.ts";
import * as InstructionManager from "../../../instructions/InstructionManager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
  ],
};

const projectId = Schema.optional(ProjectId).annotate({
  description:
    "The project whose instruction files to use. Defaults to the calling thread's project; a client outside a T3 thread passes it for project files.",
});
const agentNames = Schema.Array(ProviderInstanceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
);
const agentsDescription =
  "agents are named by provider instance id or driver kind, as in the access entries t3_instructions_list returns.";
const resultNotes =
  'Each result says changed, unchanged or failed, with a reason when it failed. Only the Global instructions (id "global:shared") can be turned on or off. An agent that has its own instructions in its home folder is not changed; the user moves those into the Global instructions in T3 Code\'s settings.';

const InstructionListTool = Tool.make("t3_instructions_list", {
  ...shared,
  description:
    "List the instruction files (AGENTS.md, CLAUDE.md and the like) T3 Code can see, in a project and in the user's home folder, and which agents read each (access: direct = reads the file where it is, link = its own file links to it, import = Claude's CLAUDE.md imports it, setting = Claude reads it through its Project instructions setting, none = does not read it). Each file has an id; pass it to t3_instructions_get. Use t3_instructions_enable and t3_instructions_disable to change which agents read the Global instructions, the one file every project shares. Editing the files, moving or deleting them, and Claude's Project instructions setting are not available to agents; edit the files directly.",
  parameters: Schema.Struct({ projectId }),
  success: InstructionListResult,
  dependencies: [...shared.dependencies, InstructionCatalog.InstructionCatalog],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InstructionGetTool = Tool.make("t3_instructions_get", {
  ...shared,
  description:
    "Read one instruction file's whole text. Name it by the id t3_instructions_list returned. contents is null when the file does not exist or is too large.",
  parameters: Schema.Struct({ projectId, id: InstructionReadInput.fields.id }),
  success: InstructionReadResult,
  dependencies: [...shared.dependencies, InstructionCatalog.InstructionCatalog],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InstructionEnableTool = Tool.make("t3_instructions_enable", {
  ...shared,
  description: `Let agents read the Global instructions: a link from the agent's own home file to it, or for Claude an import line in its CLAUDE.md. Nothing else is changed or deleted. agents is "all" for every enabled agent, or a list; ${agentsDescription} ${resultNotes} Requires a live full-access/default calling thread or a full-access client.`,
  parameters: Schema.Struct({
    agents: Schema.Union([Schema.Literal("all"), agentNames]),
  }),
  success: InstructionAgentsResult,
  dependencies: [...shared.dependencies, InstructionManager.InstructionManager],
}).annotate(Tool.Destructive, false);

const InstructionDisableTool = Tool.make("t3_instructions_disable", {
  ...shared,
  description: `Stop agents reading the Global instructions by removing the agent's link, or Claude's import line. The Global file itself is never deleted, and an agent that reads it where it is stays on. Turn it back on with t3_instructions_enable. ${agentsDescription} ${resultNotes} Requires a live full-access/default calling thread or a full-access client.`,
  parameters: Schema.Struct({ agents: agentNames }),
  success: InstructionAgentsResult,
  dependencies: [...shared.dependencies, InstructionManager.InstructionManager],
}).annotate(Tool.Destructive, false);

export const InstructionsToolkit = Toolkit.make(
  InstructionListTool,
  InstructionGetTool,
  InstructionEnableTool,
  InstructionDisableTool,
);
