import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { GROK_BACKGROUND_SUBAGENT_PROMPT } from "./input.ts";

function runAssistantTexts(
  projection: ReturnType<typeof projectionFor>,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

// A background subagent outlives its root turn. Grok ends it only with the
// root-session `subagent_finished` notification: the spawn tool completed at
// launch and nothing names the subagent done in text. Run 1 is held open for
// the subagent and completes with it; Grok's own reply to the finished
// subagent (its `subagent-completed-*` wake) is a provider continuation.
export function assertGrokBackgroundSubagentOutput(
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
  assertUserMessagesInclude(projection, [GROK_BACKGROUND_SUBAGENT_PROMPT]);
  const [rootRun, wakeRun] = projection.runs;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.origin, "provider_native");
  assert.equal(subagent?.runId, rootRun?.id, "the subagent belongs to the run that spawned it");
  const subagentItem = projection.turnItems.find((item) => item.type === "subagent");
  assert.equal(subagentItem?.status, "completed");
  assert.equal(subagentItem?.runId, rootRun?.id);

  // Run 1 settles only after the subagent's structured end.
  const subagentCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "subagent" &&
      event.payload.status === "completed",
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(subagentCompletedAt, 0);
  assert.isAbove(rootCompletedAt, subagentCompletedAt, "run 1 completed before the subagent");
  assert.include(runAssistantTexts(projection, rootRun?.id), "ROOT_DONE");

  // Grok ends ROOT_DONE with its prompt; the subagent running on must not keep
  // the reply streaming.
  const rootDoneCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.runId === rootRun?.id &&
      event.payload.type === "assistant_message" &&
      event.payload.text.trim() === "ROOT_DONE" &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(rootDoneCompletedAt, 0);
  assert.isBelow(
    rootDoneCompletedAt,
    subagentCompletedAt,
    "ROOT_DONE streamed until the subagent finished",
  );

  // The subagent's own reply stays in its child thread.
  if (subagent?.childThreadId == null) {
    throw new Error("The background subagent is missing its child thread.");
  }
  const child = result.projections.get(subagent.childThreadId);
  assert.isDefined(child);
  assert.isTrue(
    child?.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("SUBAGENT_DONE"),
    ),
    "the subagent's reply must land in its child thread",
  );
  assert.notInclude(runAssistantTexts(projection, rootRun?.id), "SUBAGENT_DONE");

  // Grok's reply to the finished subagent is a provider continuation.
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isNotEmpty(
    runAssistantTexts(projection, wakeRun?.id),
    "Grok's reply to the finished subagent must land in the continuation run",
  );
}
