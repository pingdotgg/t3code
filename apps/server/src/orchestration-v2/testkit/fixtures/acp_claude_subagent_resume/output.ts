import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { ACP_CLAUDE_SUBAGENT_RESUME_THREAD_TITLE } from "./input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The resumed subagent runs again in the run that resumed it, so run 1 stays
// finished, and its resumed work shows in the same child thread after run 2
// ended. Run 1 still takes the events of its other subagent meanwhile, which
// must not store the resumed subagent's events a second time (the shared
// one-run-per-child-thread check).
export function assertAcpClaudeSubagentResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const [launchingRun, resumingRun] = projection.runs;
  assert.lengthOf(projection.subagents, 2);
  const subagent = projection.subagents.find(
    (candidate) => candidate.nativeTaskRef?.nativeId === "toolu_agent_1",
  );
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.runId, resumingRun?.id);
  assert.equal(subagent?.prompt, "Now fix it.");
  const child =
    subagent?.childThreadId == null ? undefined : result.projections.get(subagent.childThreadId);
  // Moving the subagent to the run that resumed it keeps the user's title.
  assert.equal(child?.thread.title, ACP_CLAUDE_SUBAGENT_RESUME_THREAD_TITLE);
  assert.deepEqual(
    child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : item.type === "dynamic_tool"
          ? [`${item.type}:${item.status}`]
          : [],
    ),
    [
      "user_message:Find the flaky test.",
      "assistant_message:Found it: retry.test.ts",
      "user_message:Now fix it.",
      "dynamic_tool:completed",
      "assistant_message:Fixed retry.test.ts",
    ],
  );
  const sibling = projection.subagents.find((candidate) => candidate !== subagent);
  assert.deepEqual([sibling?.status, sibling?.runId], ["completed", launchingRun?.id]);
  const siblingThread =
    sibling?.childThreadId == null ? undefined : result.projections.get(sibling.childThreadId);
  assert.deepEqual(
    siblingThread?.messages.map((message) => message.text),
    ["Watch CI.", "CI_GREEN"],
  );
  // The SendMessage call is run 2's own tool; the child's text stays out of
  // the root.
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "dynamic_tool" ? [`${item.runId === resumingRun?.id}:${item.status}`] : [],
    ),
    ["true:completed"],
  );
  assert.isFalse(projection.messages.some((message) => message.text.includes("retry.test.ts")));
}
