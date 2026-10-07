import { assert } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
} from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./input.ts";

const SUBAGENT_TEXTS = ["SUB_STEP_1", "SUB_STEP_2", "SUB_FINAL_REPORT"];
const SUBAGENT_COMMANDS = ["sleep 3 && echo SUB_DONE_1", "sleep 3 && echo SUB_DONE_2"];
// The subagent's own task_progress, one per step, as the recording reports it.
const SUBAGENT_PROGRESS = [
  "Running Sleep 3 seconds then echo SUB_DONE_1",
  "Running Sleep 3 seconds then echo SUB_DONE_2",
];

function assistantTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

function commandTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "command_execution" ? [JSON.stringify(item.input)] : [],
  );
}

// Every frame the background subagent emits arrives after the root turn's
// result, while the root is idle. Its work reaches its child thread as it
// runs, before its end wakes the root, and none of it lands in the parent.
export function assertClaudeBackgroundSubagentAfterRootOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT]);

  const parentTexts = assistantTexts(projection);
  assert.includeMembers([...parentTexts], ["ROOT_STARTED", "ROOT_WAKE_DONE"]);
  for (const text of SUBAGENT_TEXTS) {
    assert.notInclude(parentTexts, text, `subagent text ${text} leaked into the parent thread`);
  }
  for (const command of SUBAGENT_COMMANDS) {
    assert.isFalse(
      commandTexts(projection).some((input) => input.includes(command)),
      `subagent command ${command} leaked into the parent thread`,
    );
  }

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.origin, "provider_native");
  // Its completion drains into continuation run 2, but the subagent and its
  // node stay attributed to the run that launched it.
  assert.lengthOf(projection.runs, 2);
  assert.equal(subagent?.runId, projection.runs[0]?.id);
  const subagentNode = projection.nodes.find((node) => node.id === subagent?.id);
  assert.equal(subagentNode?.status, "completed");
  assert.equal(subagentNode?.runId, projection.runs[0]?.id);
  // The continuation carries the subagent's notification summary. The
  // subagent's own foreground Bash steps are not background work, so they
  // never reach the roster or take over that summary.
  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(wakeMessage?.text, "SUB_FINAL_REPORT");
  assert.isFalse(
    result.domainEvents.some(
      (event) =>
        event.type === "provider-thread.updated" &&
        (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
    ),
  );
  if (subagent?.childThreadId == null) {
    throw new Error("The background subagent is missing its child thread.");
  }
  // Its own foreground Bash steps end before it does, but only the subagent is named.
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Subagent "Background subagent test" finished',
      outcome: "completed",
      source: { kind: "subagent", childThreadId: subagent.childThreadId },
    },
  ]);
  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.deepEqual(
    assistantTexts(childProjection).filter((text) => SUBAGENT_TEXTS.includes(text)),
    SUBAGENT_TEXTS,
    "the child thread shows the subagent's narration in order and its final report once",
  );
  for (const command of SUBAGENT_COMMANDS) {
    assert.isTrue(
      commandTexts(childProjection).some((input) => input.includes(command)),
      `subagent command ${command} must be in the child thread`,
    );
  }
  // The subagent works while the root is idle, so its steps and progress are
  // stored as they happen. Its end starts continuation run 2, which drains
  // the wake buffer; none of the subagent's work may wait there for it.
  const continuationStartIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[1]?.id &&
      event.payload.status === "starting",
  );
  assert.isAtLeast(continuationStartIndex, 0);
  const assertStoredWhileIdle = (
    label: string,
    matches: (event: OrchestrationV2DomainEvent) => boolean,
  ) => {
    const index = result.domainEvents.findIndex(matches);
    assert.isAtLeast(index, 0, `${label} is stored`);
    assert.isBelow(index, continuationStartIndex, `${label} is stored before the root wakes`);
  };
  for (const text of SUBAGENT_TEXTS) {
    assertStoredWhileIdle(
      `subagent text ${text}`,
      (event) =>
        event.type === "message.updated" &&
        event.payload.threadId === subagent.childThreadId &&
        event.payload.text.trim() === text,
    );
  }
  for (const command of SUBAGENT_COMMANDS) {
    assertStoredWhileIdle(
      `completed subagent command ${command}`,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.threadId === subagent.childThreadId &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed" &&
        event.payload.input.includes(command),
    );
  }
  for (const progress of SUBAGENT_PROGRESS) {
    assertStoredWhileIdle(
      `subagent progress "${progress}"`,
      (event) =>
        event.type === "subagent.updated" &&
        event.payload.id === subagent.id &&
        event.payload.progress === progress,
    );
  }
  // The drain stores nothing in the child thread, so nothing is stored twice.
  assert.isFalse(
    result.domainEvents
      .slice(continuationStartIndex)
      .some(
        (event) =>
          (event.type === "message.updated" || event.type === "turn-item.updated") &&
          event.payload.threadId === subagent.childThreadId,
      ),
    "the continuation run stores none of the subagent's work",
  );
}
