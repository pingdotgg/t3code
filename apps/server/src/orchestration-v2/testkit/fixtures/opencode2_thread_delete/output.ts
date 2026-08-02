import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE2_THREAD_DELETE_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2ThreadDeleteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_THREAD_DELETE_PROMPT]);
  assertAssistantTextIncludes(projection, "native deletion fixture complete");
  assert.isNotNull(projection.thread.deletedAt);
  const stoppedIndex = result.domainEvents.findIndex(
    (event) => event.type === "provider-session.updated" && event.payload.status === "stopped",
  );
  const detachedIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-session.detached" && event.threadId === projection.thread.id,
  );
  assert.isAtLeast(
    stoppedIndex,
    0,
    "the fixture's idle release must stop the managed runtime before application deletion",
  );
  assert.isAbove(
    detachedIndex,
    stoppedIndex,
    "the fixture must detach the provider session after its idle release stops the runtime",
  );
  assert.isFalse(result.shellSnapshot.threads.some((thread) => thread.id === projection.thread.id));

  const removeIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "session.remove",
  );
  assert.isAtLeast(removeIndex, 0, "application deletion must remove the native session");
}
