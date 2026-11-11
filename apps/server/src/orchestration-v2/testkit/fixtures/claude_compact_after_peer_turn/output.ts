import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "./input.ts";

export function claudeCompactRuns(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    const items = projection.turnItems.filter((item) => item.runId === run.id);
    return {
      text: message?.text,
      fromUser: message?.createdBy === "user",
      status: run.status,
      replies: items.flatMap((item) =>
        item.type === "assistant_message" ? [item.text.trim()] : [],
      ),
      compactions: items.flatMap((item) =>
        item.type === "compaction" ? [[item.beforeTokenCount, item.afterTokenCount]] : [],
      ),
    };
  });
}

export function assertClaudeCompactAfterPeerTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const runs = claudeCompactRuns(projection);
  assert.deepEqual(runs.slice(0, 2), [
    {
      text: CLAUDE_COMPACT_FIRST_PROMPT,
      fromUser: true,
      status: "completed",
      replies: ["compact probe first turn"],
      compactions: [],
    },
    {
      text: "/compact",
      fromUser: true,
      status: "completed",
      replies: [],
      compactions: [[27445, 1192]],
    },
  ]);
  assert.lengthOf(runs, 3);
  assert.isFalse(runs[2]?.fromUser);
  assert.equal(runs[2]?.status, "completed");
  assert.deepEqual(runs[2]?.replies, ["PEER_ACK"]);
  assert.deepEqual(runs[2]?.compactions, []);

  const usage = projection.runs.map(
    (run) =>
      projection.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId)
        ?.turnTokenUsage,
  );
  assert.deepInclude(usage[0], {
    outputTokens: 7,
    otherUsage: { inputTokens: 1015, outputTokens: 12 },
  });
  // /compact reports zero tokens as a local command.
  assert.deepInclude(usage[1], {
    usageStatus: "complete",
    inputTokens: 0,
    outputTokens: 0,
    localCommand: true,
  });
  // The peer result's ledger is empty, so neither it nor the next result has a baseline.
  assert.deepInclude(usage[2], { usageStatus: "complete", outputTokens: 4 });
  assert.notProperty(usage[1], "otherUsage");
  assert.notProperty(usage[2], "otherUsage");
}
