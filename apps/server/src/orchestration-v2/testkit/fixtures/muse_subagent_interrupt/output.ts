import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";

/**
 * Stop while a native subagent runs: Stop reaches Muse, and the run, the
 * subagent, its child thread and the thread's background work all settle.
 */
export function assertMuseSubagentInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["interrupted"],
  );
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  assert.isTrue(
    outbound.some(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        Reflect.get(frame, "method") === "turn/interrupt",
    ),
    "Stop must reach Muse as turn/interrupt",
  );
  assert.isFalse(projection.turnItems.some((item) => item.status === "running"));
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "interrupted");
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");
  const child = result.projections.get(subagent.childThreadId);
  if (child === undefined) throw new Error("The child thread has no projection");
  assert.isFalse(child.nodes.some((node) => node.status === "running"));
  assert.deepEqual(
    child.messages.map((message) => [message.role, message.text]),
    [["user", subagent.prompt]],
  );
}
