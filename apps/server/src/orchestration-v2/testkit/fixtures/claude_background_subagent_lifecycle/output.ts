import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "./input.ts";

const AGENT_A_TASK_ID = "a1a715b7d0bdfefea";
const AGENT_B_TASK_ID = "af44d5c14aa3ce867";
const AGENT_A_OBSERVED_MODEL = "claude-haiku-4-5-20251001";

function assistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId?: string,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" && (runId === undefined || item.runId === runId)
      ? [item.text.trim()]
      : [],
  );
}

// Messages in display order, as `role:text`.
function conversation(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .flatMap((item) =>
      item.type === "user_message"
        ? [`user:${item.text.trim()}`]
        : item.type === "assistant_message"
          ? [`assistant:${item.text.trim()}`]
          : [],
    );
}

function frameField(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

function sendMessageToolUseIds(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    const content = frameField(
      frameField(entry.type === "emit_inbound" ? entry.frame : undefined, "message"),
      "content",
    );
    return Array.isArray(content)
      ? content.flatMap((part) =>
          frameField(part, "type") === "tool_use" && frameField(part, "name") === "SendMessage"
            ? [String(frameField(part, "id"))]
            : [],
        )
      : [];
  });
}

// The recording itself is the evidence for how the CLI resumes a subagent:
// SendMessage re-emits task_started for the same task id under the
// SendMessage call's tool_use_id.
function assertRecordedResumeShape(transcript: ProviderReplayTranscript) {
  const agentAStarts = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" &&
    frameField(entry.frame, "subtype") === "task_started" &&
    frameField(entry.frame, "task_id") === AGENT_A_TASK_ID
      ? [String(frameField(entry.frame, "tool_use_id"))]
      : [],
  );
  assert.lengthOf(agentAStarts, 2, "SendMessage must re-emit task_started for Agent A");
  assert.deepEqual(agentAStarts.slice(1), sendMessageToolUseIds(transcript));
}

// Two background subagents: Agent A finishes on its own and wakes the root,
// Agent B is stopped with TaskStop, then Agent A is resumed with SendMessage
// and wakes the root again. Every wake is its own continuation run, and both
// subagents keep one child thread for their whole lifecycle.
export function assertClaudeBackgroundSubagentLifecycleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertRecordedResumeShape(transcript);
  assertBaseProjection({
    result,
    transcript,
    runCount: 7,
    runStatuses: Array.from({ length: 7 }, () => "completed" as const),
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  ]);

  const creators = projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return `${message?.createdBy}:${message?.creationSource}`;
  });
  assert.deepEqual(creators, [
    "user:web",
    "agent:provider",
    "user:web",
    "agent:provider",
    "user:web",
    "agent:provider",
    "user:web",
  ]);
  const runTexts = projection.runs.map((run) => assistantTexts(projection, run.id));
  assert.deepEqual(runTexts[0], ["LAUNCHED"]);
  assert.deepEqual(runTexts[1], ["A_REPORTED"]);
  assert.deepEqual(runTexts[2], ["B_STOPPED"]);
  assert.lengthOf(runTexts[3] ?? [], 1, "the stop notification wakes the root once");
  assert.deepEqual(runTexts[4], ["RESUMED"]);
  assert.deepEqual(runTexts[5], ["A_RESUME_REPORTED"]);
  assert.deepEqual(runTexts[6], ["ALL_DONE"]);
  for (const text of ["A_FIRST", "A_SECOND"]) {
    assert.notInclude(assistantTexts(projection), text, `${text} leaked into the parent thread`);
  }

  assert.lengthOf(projection.subagents, 2);
  const agentA = projection.subagents.find(
    (subagent) => subagent.nativeTaskRef?.nativeId === AGENT_A_TASK_ID,
  );
  const agentB = projection.subagents.find(
    (subagent) => subagent.nativeTaskRef?.nativeId === AGENT_B_TASK_ID,
  );
  assert.equal(agentB?.status, "cancelled");
  assert.equal(agentA?.status, "completed");
  assert.equal(agentA?.result, "A_SECOND");
  assert.equal(agentA?.model, AGENT_A_OBSERVED_MODEL);
  // The resume re-attributes Agent A to the run that sent the SendMessage.
  assert.equal(agentA?.runId, projection.runs[4]?.id);

  // Agent A re-opened (completed, then running again) before it completed.
  const agentAStatuses = result.domainEvents.flatMap((event) =>
    event.type === "subagent.updated" && event.payload.nativeTaskRef?.nativeId === AGENT_A_TASK_ID
      ? [event.payload.status]
      : [],
  );
  const firstCompleted = agentAStatuses.indexOf("completed");
  assert.isAtLeast(firstCompleted, 0);
  assert.isAbove(agentAStatuses.lastIndexOf("running"), firstCompleted);
  assert.equal(agentAStatuses.at(-1), "completed");

  // One child thread holds both of Agent A's runs, in order: each run's
  // prompt (the launch task, then the SendMessage text) before its reply.
  const agentAChild =
    agentA?.childThreadId == null ? undefined : result.projections.get(agentA.childThreadId);
  assert.isDefined(agentAChild);
  assert.deepEqual(assistantTexts(agentAChild), ["A_FIRST", "A_SECOND"]);
  assert.deepEqual(conversation(agentAChild), [
    "user:Reply with exactly: A_FIRST",
    "assistant:A_FIRST",
    "user:Reply with exactly: A_SECOND",
    "assistant:A_SECOND",
  ]);

  // The recording's subagent thinking lands in each child thread, before the
  // reply it led to, and never in the parent.
  const thinkingOf = (child: OrchestrationV2ThreadProjection | undefined) =>
    (child?.turnItems ?? []).flatMap((item) =>
      item.type === "reasoning" && item.title === "Thinking" ? [item] : [],
    );
  const agentAThinking = thinkingOf(agentAChild);
  assert.lengthOf(agentAThinking, 2, "both of Agent A's runs thought before replying");
  assert.include(agentAThinking[0]?.text, '"A_FIRST"');
  assert.include(agentAThinking[1]?.text, '"A_SECOND"');
  for (const item of agentAThinking) {
    assert.equal(item.status, "completed");
    assert.isFalse(item.streaming);
    assert.isNull(item.runId);
  }
  const agentAOrder = agentAChild.turnItems.flatMap((item) =>
    item.type === "assistant_message"
      ? [item.text.trim()]
      : item.type === "reasoning" && item.title === "Thinking"
        ? ["thinking"]
        : [],
  );
  assert.deepEqual(agentAOrder, ["thinking", "A_FIRST", "thinking", "A_SECOND"]);
  const agentBChild =
    agentB?.childThreadId == null ? undefined : result.projections.get(agentB.childThreadId);
  assert.lengthOf(thinkingOf(agentBChild), 1);
  assert.include(thinkingOf(agentBChild)[0]?.text, "B_DONE");
  const subagentThinking = new Set(
    [...agentAThinking, ...thinkingOf(agentBChild)].map((item) => item.text),
  );
  assert.isFalse(
    thinkingOf(projection).some((item) => subagentThinking.has(item.text)),
    "subagent thinking leaked into the parent thread",
  );

  // Subagents appear in background_tasks_changed but never on the roster.
  assert.isFalse(
    result.domainEvents.some(
      (event) =>
        event.type === "provider-thread.updated" &&
        (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
    ),
  );
}
