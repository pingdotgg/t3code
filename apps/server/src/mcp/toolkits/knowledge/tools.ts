import {
  KnowledgeMapEntry,
  KnowledgeMapMarkDoneInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";

import * as KnowledgeMap from "../../../knowledgeMap.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const KnowledgeMapReadTool = Tool.make("knowledge_map_read", {
  description:
    "The learner's 'What you know' map: topics they explained back, with their words and prerequisites. Read it before teaching a topic.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(KnowledgeMapEntry.mapFields(Struct.omit(["threadId"]))),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, KnowledgeMap.KnowledgeMap],
})
  .annotate(Tool.Title, "Read What you know")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const KnowledgeMapMarkDoneTool = Tool.make("knowledge_map_mark_done", {
  description:
    "Save a topic to the learner's 'What you know' map. Only after the learner explained it back in their own words and you graded it as correct; pass their words as `explanation`. Marking a topic again replaces it.",
  parameters: KnowledgeMapMarkDoneInput,
  success: Schema.Struct({ saved: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    KnowledgeMap.KnowledgeMap,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Save to What you know")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const KnowledgeToolkit = Toolkit.make(KnowledgeMapReadTool, KnowledgeMapMarkDoneTool);
