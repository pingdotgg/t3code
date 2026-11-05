import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as KnowledgeMap from "../../../knowledgeMap.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Topic = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
);
const Explanation = Schema.String.check(Schema.isMaxLength(600));
const BuildsOn = Schema.Array(Topic).check(
  Schema.makeFilter((value: readonly unknown[]) => value.length <= 8, {
    message: "at most 8 items",
  }),
);

const KnowledgeMapReadTool = Tool.make("knowledge_map_read", {
  description:
    "The learner's 'What you know' map: topics they explained back, with their words and prerequisites. Read it before teaching a topic.",
  parameters: Tool.EmptyParams,
  success: Schema.Array(
    Schema.Struct({
      topic: Topic,
      explanation: Explanation,
      buildsOn: BuildsOn,
      doneAt: Schema.String,
    }),
  ),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, KnowledgeMap.KnowledgeMap],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CompactEntry = Schema.Struct({
  topic: Topic,
  explanation: Explanation,
  buildsOn: BuildsOn,
  doneAt: Schema.String,
});
const CompactEntries = Schema.Array(CompactEntry);

const KnowledgeMapMarkDoneTool = Tool.make("knowledge_map_mark_done", {
  description:
    "Save a topic to the learner's 'What you know' map. Only after the learner explained it back in their own words and you graded it as correct; pass their words as `explanation`. Marking a topic again replaces it.",
  parameters: Schema.Struct({
    topic: Topic,
    explanation: Explanation,
    buildsOn: Schema.optional(BuildsOn),
  }),
  success: CompactEntries,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    KnowledgeMap.KnowledgeMap,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const KnowledgeToolkit = Toolkit.make(KnowledgeMapReadTool, KnowledgeMapMarkDoneTool);
