import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { ACP_CLAUDE_CYCLE_FIRST_PROMPT, ACP_CLAUDE_CYCLE_SECOND_PROMPT } from "./input.ts";

export function assertAcpClaudePromptDuringAgentCycleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "interrupted"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const [firstRun, secondRun, stoppedRun] = projection.runs;
  const assistantTexts = (runId: string | undefined) =>
    projection.messages.flatMap((message) =>
      message.runId === runId && message.role === "assistant"
        ? [`${message.text}${message.streaming ? " (streaming)" : ""}`]
        : [],
    );

  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    [ACP_CLAUDE_CYCLE_FIRST_PROMPT, ACP_CLAUDE_CYCLE_SECOND_PROMPT],
  );
  assert.deepEqual(assistantTexts(firstRun?.id), ["Started the background subagent."]);
  // The cycle Claude finished before taking the prompt in streamed into the
  // prompt's run; its idle did not end that run before the answer.
  assert.deepEqual(assistantTexts(secondRun?.id), [
    "The subagent finished.",
    "Nothing else is left.",
  ]);
  const stoppedMessage = projection.messages.find(
    (message) => message.id === stoppedRun?.userMessageId,
  );
  assert.equal(`${stoppedMessage?.createdBy}:${stoppedMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(assistantTexts(stoppedRun?.id), ["Looking at the results."]);
}
