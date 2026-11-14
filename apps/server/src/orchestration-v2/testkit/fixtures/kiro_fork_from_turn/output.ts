import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertBaseProjection, assertSemanticProjectionIntegrity, field } from "../shared.ts";

export function assertKiroForkFromTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const target = [...result.projections.values()].find(
    (projection) => projection.thread.lineage.relationshipToParent === "fork",
  );
  assert.isDefined(target, "the fork must create a target thread");
  assertSemanticProjectionIntegrity(target);
  assert.equal(target.contextTransfers[0]?.resolution?.strategy, "native_fork");

  // Kiro forks at the first prompt's `userMessageId`, so its reply comes along and the second turn doesn't.
  const inbound = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" ? [entry.frame] : [],
  );
  const firstMessageId = inbound
    .map((frame) => field(field(field(field(frame, "params"), "update"), "_meta"), "kiro"))
    .find((kiro) => field(kiro, "kind") === "user_message_id_assigned");
  const forks = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "method") === "session/fork"
      ? [entry.frame]
      : [],
  );
  assert.lengthOf(forks, 1);
  assert.deepEqual(field(field(forks[0], "params"), "_meta"), {
    kiro: { messageId: field(firstMessageId, "userMessageId") },
  });

  const targetText = target.turnItems
    .map((item) => (item.type === "assistant_message" ? item.text : ""))
    .join("\n");
  assert.include(targetText, "fork boundary alpha");
  assert.notInclude(targetText, "fork boundary beta");
}
