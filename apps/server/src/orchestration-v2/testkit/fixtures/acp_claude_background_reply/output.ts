import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { ACP_CLAUDE_BACKGROUND_REPLY_PROMPT } from "./input.ts";

const ROOT_REPLY = "Started the background subagent. I will report back when it finishes.";

// The turn's idle completes run 1 and its reply while the background subagent
// still runs. The subagent's own output streams into its child thread while
// no run is active, and its idle ends it. Claude's own follow-up once the
// subagent finished streams live into a provider continuation that ends at
// Claude's next idle.
export function assertAcpClaudeBackgroundReplyOutput(
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
  const [rootRun, followUpRun] = projection.runs;

  // The prompt's v2 echo is the prompt already shown, not a second message.
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    [ACP_CLAUDE_BACKGROUND_REPLY_PROMPT],
  );
  // The Agent call is the subagent's row, and subagent work states are not
  // shown as unknown updates.
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "dynamic_tool" || item.type === "subagent" ? [item.type] : [],
    ),
    ["subagent"],
  );

  const rootReply = projection.messages.find(
    (message) => message.runId === rootRun?.id && message.role === "assistant",
  );
  assert.equal(rootReply?.text, ROOT_REPLY);
  assert.isFalse(rootReply?.streaming);

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.runId, rootRun?.id, "the subagent belongs to the run that spawned it");
  assert.equal(subagent?.title, "Wait in the background");
  if (subagent?.childThreadId == null) {
    throw new Error("The background subagent is missing its child thread.");
  }
  const childThreadId = subagent.childThreadId;
  const child = result.projections.get(childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : item.type === "dynamic_tool"
          ? [`${item.type}:${item.status}`]
          : [],
    ),
    [
      "user_message:Sleep for a second, then reply SUBAGENT_DONE.",
      "assistant_message:Sleeping before I report.",
      "dynamic_tool:completed",
      "assistant_message:SUBAGENT_DONE",
    ],
  );
  // The subagent's output stays in its child thread, and output of a session
  // no parent announced shows nowhere.
  for (const thread of result.projections.values()) {
    assert.isFalse(thread.messages.some((message) => message.text.includes("STRAY_SESSION_TEXT")));
  }
  assert.isFalse(
    projection.messages.some((message) => message.text.includes("Sleeping before I report.")),
  );

  const followUpMessage = projection.messages.find(
    (message) => message.id === followUpRun?.userMessageId,
  );
  assert.equal(
    `${followUpMessage?.createdBy}:${followUpMessage?.creationSource}`,
    "agent:provider",
  );
  const followUpReply = projection.messages.find(
    (message) => message.runId === followUpRun?.id && message.role === "assistant",
  );
  assert.equal(followUpReply?.text, "The background subagent finished: SUBAGENT_DONE");
  assert.isFalse(followUpReply?.streaming);

  // Claude followed up once the subagent finished: its run opens with the
  // report of that end, which the adapter records before it offers the run.
  // (The two runs store their events independently, so their order in the
  // log says nothing here.)
  const report = projection.turnItems.find(
    (item) => item.type === "notification" && item.runId === followUpRun?.id,
  );
  assert.equal(report?.type === "notification" ? report.outcome : undefined, "completed");

  // Run 1 and its reply completed, then the subagent's output showed live
  // while no run was active, then it finished.
  const indexOf = (predicate: (event: (typeof result.domainEvents)[number]) => boolean) =>
    result.domainEvents.findIndex(predicate);
  const rootCompletedAt = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  const childProgressAt = indexOf(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.threadId === childThreadId &&
      event.payload.type === "assistant_message" &&
      event.payload.text === "Sleeping before I report.",
  );
  const subagentCompletedAt = indexOf(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "subagent" &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(rootCompletedAt, 0);
  assert.isAbove(childProgressAt, rootCompletedAt);
  assert.isAbove(subagentCompletedAt, childProgressAt);
}
