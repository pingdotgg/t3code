import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

/** The messages and tool statuses of a subagent's child thread, in order. */
function childThreadLines(
  result: OrchestratorV2ScenarioResult,
  childThreadId: string | null | undefined,
) {
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId as never);
  return child?.turnItems.flatMap((item) =>
    item.type === "assistant_message" || item.type === "user_message"
      ? [`${item.type}:${item.text}`]
      : item.type === "dynamic_tool"
        ? [`${item.type}:${item.status}`]
        : [],
  );
}

// The run fails while its background subagent runs on. That run takes no
// more events, so the subagent moves to the run that shows it next (Claude's
// report, run 2), where its output and its end show. Claude's follow-up is
// run 3.
export function assertAcpClaudeFailedPromptBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["failed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const [, showingRun] = projection.runs;
  assert.deepEqual(
    projection.subagents.map(
      (subagent) => `${subagent.status}:${subagent.runId === showingRun?.id}`,
    ),
    ["completed:true"],
  );
  assert.deepEqual(childThreadLines(result, projection.subagents[0]?.childThreadId), [
    "user_message:Sleep for a second, then reply SUBAGENT_DONE.",
    "assistant_message:Sleeping before I report.",
    "dynamic_tool:completed",
    "assistant_message:SUBAGENT_DONE",
  ]);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
