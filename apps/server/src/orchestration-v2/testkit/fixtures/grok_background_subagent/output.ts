import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import {
  GROK_BACKGROUND_SUBAGENT_PROMPT,
  GROK_BACKGROUND_SUBAGENT_QUEUED_PROMPT,
  GROK_BACKGROUND_SUBAGENT_STEER_PROMPT,
} from "./input.ts";

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
// launch and nothing names the subagent done in text. Run 1 completes with its
// reply while the subagent runs on (#17159): the thread waits on the subagent,
// a queued message starts at once, and a steer starts a new turn instead of
// superseding the finished reply. Grok's own reply to the finished subagent
// (its `subagent-completed-*` wake) is a provider continuation.
export function assertGrokBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 4,
    runStatuses: ["completed", "completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    GROK_BACKGROUND_SUBAGENT_PROMPT,
    GROK_BACKGROUND_SUBAGENT_QUEUED_PROMPT,
    GROK_BACKGROUND_SUBAGENT_STEER_PROMPT,
  ]);
  const [rootRun, queuedRun, steerRun, wakeRun] = projection.runs;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.origin, "provider_native");
  assert.equal(subagent?.runId, rootRun?.id, "the subagent belongs to the run that spawned it");
  const subagentItem = projection.turnItems.find((item) => item.type === "subagent");
  assert.equal(subagentItem?.status, "completed");
  assert.equal(subagentItem?.runId, rootRun?.id);

  // Run 1 completes with ROOT_DONE; the running subagent does not hold it.
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
  assert.isAtLeast(rootCompletedAt, 0);
  assert.isBelow(rootCompletedAt, subagentCompletedAt, "run 1 waited for the subagent");
  assert.include(runAssistantTexts(projection, rootRun?.id), "ROOT_DONE");

  // While the subagent runs, clients see the thread waiting on it, not working.
  const waitingShell = result.capturedShellSnapshots
    .get("while-subagent-runs")
    ?.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(
    waitingShell?.pendingBackgroundTasks?.map((task) => [
      task.kind,
      task.kind === "subagent" ? task.childThreadId : undefined,
    ]),
    [["subagent", subagent?.childThreadId]],
    "the Waiting strip names the running subagent",
  );
  assert.isNull(waitingShell?.activeRunId, "no run is working while only the subagent runs");

  // The queued message did not wait for the subagent, and the steer started a
  // new turn: no finished reply was superseded.
  assert.deepEqual(runAssistantTexts(projection, queuedRun?.id), ["QUEUED_DONE"]);
  assert.deepEqual(runAssistantTexts(projection, steerRun?.id), ["STEER_DONE"]);
  const queuedStartedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === queuedRun?.id &&
      event.payload.status === "running",
  );
  assert.isBelow(
    queuedStartedAt,
    subagentCompletedAt,
    "the queued message waited for the subagent",
  );
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["completed", "completed", "completed", "completed"],
  );

  // The subagent's own work, done after run 1 settled, lands in its child thread.
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
  const childTools = child?.turnItems.filter((item) => item.type === "dynamic_tool") ?? [];
  // Its poll of the sleep, made after run 1 completed, still projects.
  assert.include(
    childTools.map((item) => `${item.title}:${item.status}`),
    "sleep 20 (call-d54):completed",
    "the subagent's tool calls must land in its child thread",
  );
  for (const run of projection.runs) {
    assert.notInclude(runAssistantTexts(projection, run.id), "SUBAGENT_DONE");
  }

  // The timeline says which subagent finished, and opens its thread.
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Subagent "Sleep then reply done" finished',
      outcome: "completed",
      source: { kind: "subagent", childThreadId: subagent.childThreadId },
    },
  ]);

  // Grok's reply to the finished subagent is a provider continuation.
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isNotEmpty(
    runAssistantTexts(projection, wakeRun?.id),
    "Grok's reply to the finished subagent must land in the continuation run",
  );
}
