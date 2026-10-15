import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// Both subagents complete with all their output in their own threads, and
// nothing of the stray session shows anywhere.
export function assertAcpClaudeSubagentLineageOutput(
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
  const [rootRun] = projection.runs;
  const childItems = (title: string) => {
    const subagent = projection.subagents.find((candidate) => candidate.title === title);
    assert.equal(subagent?.status, "completed", title);
    assert.equal(subagent?.runId, rootRun?.id, title);
    const child =
      subagent?.childThreadId == null ? undefined : result.projections.get(subagent.childThreadId);
    return child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : [],
    );
  };
  assert.lengthOf(projection.subagents, 2);
  assert.deepEqual(childItems("Collect notes"), [
    "user_message:Collect the notes.",
    "assistant_message:A_BEFORE_ROW",
    "assistant_message:A_DONE",
  ]);
  assert.deepEqual(childItems("Check tests"), [
    "user_message:Check the tests.",
    "assistant_message:B_AFTER_SETTLE",
  ]);
  const shown = [...result.projections.values()].flatMap((thread) =>
    thread.messages.map((message) => message.text),
  );
  assert.isFalse(shown.some((text) => text.includes("STRAY")));
  assert.deepEqual(
    projection.messages.flatMap((message) => (message.role === "assistant" ? [message.text] : [])),
    ["Started two subagents.", "Both subagents finished."],
  );
}
