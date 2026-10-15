import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The nested subagent's work shows in its parent subagent's thread, after the
// Agent call that started it, and never in the root.
export function assertAcpClaudeNestedSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  const child =
    subagent?.childThreadId == null ? undefined : result.projections.get(subagent.childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : item.type === "dynamic_tool"
          ? [`${item.type}:${item.status}`]
          : [],
    ),
    [
      "user_message:Review the change.",
      "assistant_message:Starting a helper.",
      "dynamic_tool:completed",
      "dynamic_tool:completed",
      "assistant_message:NESTED_DOCS_OK",
      "assistant_message:Review done.",
    ],
  );
  assert.isFalse(projection.messages.some((message) => message.text.includes("NESTED_DOCS_OK")));
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.title] : [])),
    [],
  );
}
