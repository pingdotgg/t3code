import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  CLAUDE_LOCAL_BASH_TASK_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertClaudeLocalBashTaskOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  assert.lengthOf(
    result.projections,
    1,
    "Claude local_bash task lifecycle events must not create child app threads",
  );

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_LOCAL_BASH_TASK_PROMPT]);
  assert.deepEqual(
    projection.turnItems.filter((item) => item.type !== "checkpoint").map((item) => item.type),
    ["user_message", "assistant_message", "command_execution", "assistant_message"],
  );

  assert.lengthOf(
    projection.subagents,
    0,
    "Claude local_bash task lifecycle events must not project subagents",
  );
  assert.lengthOf(
    projection.nodes.filter((node) => node.kind === "subagent"),
    0,
    "Claude local_bash task lifecycle events must not project subagent nodes",
  );

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, [
    "I'll run the typecheck command now.",
    "claude local bash task fixture complete",
  ]);

  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(command);
  assert.include(JSON.stringify(command ?? null), "vp run --filter @t3tools/web typecheck");
  assert.include(JSON.stringify(command?.output ?? null), "tsgo --noEmit");
}
