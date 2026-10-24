import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";

/** Tool call ids Kiro reported `failed` after T3's `session/cancel`. */
export function kiroFailedAfterCancel(transcript: ProviderReplayTranscript): Array<string> {
  const cancelIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "notification:session/cancel",
  );
  assert.isAtLeast(cancelIndex, 0, "Stop must reach Kiro as session/cancel");
  return transcript.entries.slice(cancelIndex).flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const params = Reflect.get(Object(entry.frame), "params");
    const update = Reflect.get(Object(params), "update");
    return Reflect.get(Object(update), "sessionUpdate") === "tool_call_update" &&
      Reflect.get(Object(update), "status") === "failed"
      ? [String(Reflect.get(Object(update), "toolCallId"))]
      : [];
  });
}

/** Kiro fails the sub-agent and its running command on cancel; T3 shows both interrupted. */
export function assertKiroSubagentInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const failed = kiroFailedAfterCancel(transcript);
  assert.isTrue(
    failed.some((id) => id.startsWith("invoke_subagent_")),
    "Kiro must fail the sub-agent after the cancel",
  );
  assert.isTrue(
    failed.some((id) => !id.startsWith("invoke_subagent_")),
    "Kiro must fail the sub-agent's command after the cancel",
  );

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["interrupted"],
  );
  assert.isFalse(
    projection.turnItems.some((item) => item.status === "running" || item.status === "failed"),
  );

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "interrupted");
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");
  const child = result.projections.get(subagent.childThreadId);
  if (child === undefined) throw new Error("The child thread has no projection");
  const tools = child.turnItems.filter((item) => item.type === "dynamic_tool");
  assert.isNotEmpty(tools);
  assert.deepEqual(
    tools.map((item) => item.status),
    tools.map(() => "interrupted"),
  );
  assert.isFalse(child.nodes.some((node) => node.status === "running" || node.status === "failed"));
}
