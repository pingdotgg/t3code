import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_PROMPT,
} from "../shared.ts";

/** Muse cannot address child sessions; their threads contain only the prompt and one result. */
export function assertMuseSubagentV2Output(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_PROMPT]);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed"],
  );
  assert.lengthOf(projection.subagents, 1);
  assert.lengthOf(result.shellSnapshot.threads, 2);

  const subagent = projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.driver, "muse");
  assert.equal(subagent.status, "completed");
  assert.isNotEmpty(subagent.prompt);
  assert.match(subagent.result ?? "", /^Hello\.?$/u);
  assert.isNotNull(subagent.completedAt);
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");

  const row = projection.turnItems.find(
    (item) => item.type === "subagent" && item.subagentId === subagent.id,
  );
  assert.equal(row?.type === "subagent" ? row.childThreadId : undefined, subagent.childThreadId);

  const child = result.projections.get(subagent.childThreadId);
  if (child === undefined) throw new Error("The child thread has no projection");
  assert.equal(child.thread.lineage.parentThreadId, projection.thread.id);
  assert.equal(child.thread.lineage.relationshipToParent, "subagent");
  assert.lengthOf(child.runs, 0);
  assert.deepEqual(
    child.messages.map((message) => [message.role, message.text]),
    [
      ["user", subagent.prompt],
      ["assistant", subagent.result],
    ],
  );
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
}
