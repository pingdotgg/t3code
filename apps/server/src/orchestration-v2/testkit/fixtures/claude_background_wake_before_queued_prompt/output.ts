import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "../claude_background_subagent_lifecycle/input.ts";
import { CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT } from "./input.ts";

const STOP_WAKE_REPLY =
  "Agent B's kill is confirmed by the notification. No further action needed — the task is complete.";

function frameField(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

// The recording itself shows the ordering this fixture guards: the CLI ran a
// wake turn between the resume prompt's offer and that prompt's own turn, and
// only the prompt's turn echoed its uuid.
function assertRecordedWakeBeforePrompt(transcript: ProviderReplayTranscript) {
  const resumeOfferIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "prompt.offer:3",
  );
  const resumeOffer = transcript.entries[resumeOfferIndex];
  const resumeUuid = frameField(
    frameField(resumeOffer?.type === "expect_outbound" ? resumeOffer.frame : undefined, "message"),
    "uuid",
  );
  assert.isString(resumeUuid, "the resume prompt must carry a uuid");
  const resultsAfterOffer = transcript.entries
    .slice(resumeOfferIndex + 1)
    .flatMap((entry) =>
      entry.type === "emit_inbound" && frameField(entry.frame, "type") === "result"
        ? [entry.frame]
        : [],
    );
  const [wakeResult, promptResult] = resultsAfterOffer;
  assert.equal(frameField(frameField(wakeResult, "origin"), "kind"), "task-notification");
  assert.isUndefined(frameField(wakeResult, "user_message_uuid"));
  assert.equal(frameField(promptResult, "user_message_uuid"), resumeUuid);
}

function repliesByMessage(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      fromUser: message?.createdBy === "user",
      text: message?.text,
      replies: projection.turnItems.flatMap((item) =>
        item.runId === run.id && item.type === "assistant_message" ? [item.text.trim()] : [],
      ),
    };
  });
}

// A wake turn that Claude runs before a queued prompt belongs to a
// continuation run; the prompt's run shows only the prompt's own reply.
export function assertClaudeBackgroundWakeBeforeQueuedPromptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertRecordedWakeBeforePrompt(transcript);
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const runs = repliesByMessage(projection);

  const userReplies = runs.filter((run) => run.fromUser).map((run) => [run.text, run.replies]);
  assert.deepEqual(userReplies, [
    [CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT, ["LAUNCHED"]],
    [CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT, ["B_STOPPED"]],
    [CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT, ["RESUMED"]],
    [CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT, ["ALL_DONE"]],
  ]);
  const continuationReplies = runs.filter((run) => !run.fromUser).flatMap((run) => run.replies);
  assert.sameMembers(continuationReplies, ["A_REPORTED", STOP_WAKE_REPLY]);
  assert.isTrue(projection.runs.every((run) => run.status === "completed"));
}
