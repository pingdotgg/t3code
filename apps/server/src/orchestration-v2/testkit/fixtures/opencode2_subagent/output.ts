import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertProviderNativeSubagentRootTurns,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE2_SUBAGENT_PROMPT,
  projectionFor,
} from "../shared.ts";

const CHILD_PROMPT = "List the files in the current directory and report their names.";

export function assertOpenCode2SubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertProviderNativeSubagentRootTurns(result);
  assertUserMessagesInclude(projection, [OPENCODE2_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "hello.txt");

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.deepInclude(subagent, {
    origin: "provider_native",
    status: "completed",
    prompt: CHILD_PROMPT,
    title: "List files in current directory",
    runId: projection.runs[0]!.id,
  });
  assert.include(subagent.result ?? "", "hello.txt");
  assert.notInclude(subagent.result ?? "", "<subagent", "the result is the answer, not the tag");
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "subagent" ? [item.status] : [])),
    ["completed"],
  );
  assert.isFalse(
    projection.turnItems.some(
      (item) => item.type === "dynamic_tool" || item.type === "file_search",
    ),
    "the child's read and glob calls must not land on the parent",
  );

  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);
  assert.equal(child.thread.lineage.relationshipToParent, "subagent");
  assert.deepEqual(
    child.providerTurns.map((turn) => turn.status),
    ["completed"],
  );
  assertUserMessagesInclude(child, [CHILD_PROMPT]);
  assert.isAtLeast(
    child.turnItems.filter((item) => item.type === "dynamic_tool" || item.type === "file_search")
      .length,
    2,
  );
  assertAssistantTextIncludes(child, "hello.txt");
  assert.equal(projection.providerTurns[0]?.turnTokenUsage?.hasSubagents, true);
}
