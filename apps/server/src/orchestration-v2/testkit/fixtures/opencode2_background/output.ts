import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertProviderNativeSubagentRootTurns,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  OPENCODE2_BACKGROUND_PROMPT,
  projectionFor,
} from "../shared.ts";

const runTexts = (projection: OrchestrationV2ThreadProjection, runId: string | undefined) =>
  projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );

/**
 * A background `subagent` call. The parent's first execution ends at once,
 * so run 1 waits on the subagent. When it ends, OpenCode reports it to the
 * parent and runs the parent again on its own: that execution is run 2, a
 * continuation T3 opens for it, and nothing stays waiting afterwards.
 */
export function assertOpenCode2BackgroundOutput(
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
  assertProviderNativeSubagentRootTurns(result);
  assertUserMessagesInclude(projection, [OPENCODE2_BACKGROUND_PROMPT]);
  const [rootRun, wakeRun] = projection.runs;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.deepInclude(subagent, {
    origin: "provider_native",
    status: "completed",
    runId: rootRun!.id,
    title: "Sleep and reply",
    result: "CHILD_OK",
  });
  assert.deepEqual(runTexts(projection, rootRun?.id), ["PARENT_OK"]);

  // Run 1's turn ends while the subagent runs: the run parks at `waiting` on
  // that background work, and the wake follows the subagent's end.
  const indexOf = (predicate: (event: (typeof result.domainEvents)[number]) => boolean) =>
    result.domainEvents.findIndex(predicate);
  const rootWaiting = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "waiting",
  );
  const subagentDone = indexOf(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "subagent" &&
      event.payload.status === "completed",
  );
  const wakeStarted = indexOf(
    (event) => event.type === "run.updated" && event.payload.id === wakeRun?.id,
  );
  assert.isAtLeast(rootWaiting, 0);
  assert.isAbove(subagentDone, rootWaiting, "run 1 ends its turn before its subagent ends");
  assert.isAbove(wakeStarted, subagentDone, "the wake follows the subagent's end");

  // The child's own tool call and answer stay in its thread.
  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);
  assert.isTrue(
    child.turnItems.some(
      (item) => item.type === "command_execution" && item.input.includes("sleep 20"),
    ),
  );
  assert.isTrue(
    child.turnItems.some((item) => item.type === "assistant_message" && item.text === "CHILD_OK"),
  );
  assert.isFalse(
    projection.turnItems.some((item) => item.type === "command_execution"),
    "the child's shell call must not land on the parent",
  );

  // The continuation is a provider wake that names the subagent, and it
  // carries the parent's own answer to the report.
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.include(wakeMessage?.text ?? "", "CHILD_OK");
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Subagent "Sleep and reply" finished',
      outcome: "completed",
      source: { kind: "subagent", childThreadId: subagent.childThreadId! },
    },
  ]);
  assert.deepEqual(runTexts(projection, wakeRun?.id), [
    "The background subagent finished and returned `CHILD_OK`.",
  ]);

  // Nothing is left waiting once the subagent and the wake ended.
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
  assert.isFalse(
    projection.turnItems.some((item) => item.status === "running" || item.status === "waiting"),
  );
}
