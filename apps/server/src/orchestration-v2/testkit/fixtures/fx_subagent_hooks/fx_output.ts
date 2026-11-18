import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertProviderNativeSubagentRootTurns,
  assertSemanticProjectionIntegrity,
  projectionFor,
  SUBAGENT_PROMPT,
  assertUserMessagesInclude,
} from "../shared.ts";

/**
 * With fx's hooks each child thread shows the child's own steps and ends on
 * its whole reply, which ACP alone clips to 200 bytes.
 */
export function assertFxSubagentHooksOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertProviderNativeSubagentRootTurns(result);
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "dynamic_tool",
    "the subagent calls must not also show as tool rows",
  );

  assert.lengthOf(projection.subagents, 2);
  for (const subagent of projection.subagents) {
    assert.equal(subagent.status, "completed");
    assert.isNotNull(subagent.providerThreadId, "the child's fx session is its provider thread");
    const reply = subagent.result ?? "";
    assert.isAbove(reply.length, 200, "the reply is fx's whole result, not its ACP preview");
    assert.notInclude(reply, '"ok":');
    assert.isFalse(reply.endsWith("…"));
    if (subagent.childThreadId === null) throw new Error(`Subagent ${subagent.id} has no thread`);

    const child = result.projections.get(subagent.childThreadId);
    assert.isDefined(child);
    const items = child.turnItems.toSorted((left, right) => left.ordinal - right.ordinal);
    assert.equal(items[0]?.type, "user_message");
    assertUserMessagesInclude(child, [subagent.prompt]);
    const steps = items.filter((item) => item.type === "dynamic_tool");
    assert.isNotEmpty(steps, "the child's tool calls are its steps");
    for (const step of steps) {
      assert.equal(step.status, "completed");
      assert.notEqual(step.title, "Tool", "a step keeps fx's tool and its input in its title");
    }
    const last = items.at(-1);
    assert.equal(last?.type === "assistant_message" ? last.text : null, reply);
    assert.lengthOf(
      items.filter((item) => item.type === "assistant_message" && item.text === reply),
      1,
      "the reply shows once",
    );
    assert.isFalse(
      projection.turnItems.some((item) => item.type === "assistant_message" && item.text === reply),
      "the child's reply leaked into the parent thread",
    );
  }
}
