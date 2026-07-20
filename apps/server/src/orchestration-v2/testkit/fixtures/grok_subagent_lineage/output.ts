import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertTurnItemTypes,
  projectionFor,
} from "../shared.ts";

const EXPECTED_CHILDREN = [
  {
    title: "Explore server architecture",
    sessionId: "019f0220-e192-7c41-9e9d-b406bc3459c8",
    first: "I'll audit `apps/server` by mapping its layout first",
    second: "# `apps/server` Audit Summary",
  },
  {
    title: "Explore web client architecture",
    sessionId: "019f0220-e197-7833-a8e4-ad38f2bd5b4c",
    first: "Auditing `apps/web`: mapping package structure",
    second: "# `apps/web` Audit Summary",
  },
] as const;

export function assertGrokSubagentLineageOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const parent = projectionFor(result, transcript.scenario);
  assertTurnItemTypes(parent, ["user_message", "subagent", "subagent", "assistant_message"]);
  assertExecutionNodeKinds(parent, ["root_turn", "subagent", "subagent", "assistant_message"]);
  assertNoExtraAppRunsForProviderChildren({ projection: parent, expectedAppRuns: 1 });
  assert.lengthOf(parent.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.notInclude(
    parent.messages.map((message) => message.text).join("\n"),
    "Audit Summary",
    "interleaved child output must not leak into the parent timeline",
  );

  for (const expected of EXPECTED_CHILDREN) {
    const subagent = parent.subagents.find((candidate) => candidate.title === expected.title);
    assert.isDefined(subagent);
    assert.equal(subagent.status, "completed");
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.driver, "grok");
    assert.isNotNull(subagent.childThreadId);
    assert.isNotNull(subagent.providerThreadId);
    assert.include(subagent.result ?? "", expected.first);
    assert.include(subagent.result ?? "", expected.second);
    if (subagent.childThreadId === null || subagent.providerThreadId === null) {
      throw new Error(`Grok subagent ${expected.title} is missing lineage`);
    }

    const child = result.projections.get(subagent.childThreadId);
    assert.isDefined(child);
    assert.equal(child.thread.lineage.parentThreadId, parent.thread.id);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.equal(child.thread.lineage.rootThreadId, parent.thread.lineage.rootThreadId);
    assert.equal(child.thread.activeProviderThreadId, subagent.providerThreadId);
    assert.lengthOf(child.runs, 0);
    assert.lengthOf(child.providerThreads, 1);
    assert.equal(child.providerThreads[0]?.nativeThreadRef?.nativeId, expected.sessionId);
    const forkedFrom = child.providerThreads[0]?.forkedFrom;
    if (forkedFrom == null) {
      throw new Error(`Grok subagent ${expected.title} is missing provider lineage`);
    }
    assert.notEqual(forkedFrom.providerThreadId, subagent.providerThreadId);
    assert.isTrue(
      parent.providerTurns.some(
        (turn) =>
          turn.id === forkedFrom.providerTurnId &&
          turn.providerThreadId === forkedFrom.providerThreadId,
      ),
      "the native child session must fork from the parent provider turn",
    );
    assertTurnItemTypes(child, ["user_message", "assistant_message"]);
    const assistant = child.messages.find((message) => message.role === "assistant");
    assert.isDefined(assistant);
    assert.isBelow(assistant.text.indexOf(expected.first), assistant.text.indexOf(expected.second));

    // Coalescing (audit plan #10): the subagent streamed a progress chunk and
    // a result chunk into this one result message. Without coalescing each
    // chunk persisted its own full-row message.updated event; the throttle
    // collapses intermediate emits so the final text lands in a single flush.
    const resultMessageEvents = result.storedEvents.filter((stored) => {
      if (stored.event.type !== "message.updated") return false;
      const payload = stored.event.payload as { readonly id?: unknown; readonly threadId?: unknown };
      return payload.threadId === subagent.childThreadId && payload.id === assistant.id;
    });
    assert.lengthOf(
      resultMessageEvents,
      1,
      `expected coalesced subagent result for ${expected.title}, got ${resultMessageEvents.length} message.updated events`,
    );
    for (const other of EXPECTED_CHILDREN) {
      if (other.sessionId !== expected.sessionId) {
        assert.notInclude(
          assistant.text,
          other.second,
          "interleaved chunks must remain isolated to their native child session",
        );
      }
    }
  }
}
