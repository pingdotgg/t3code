import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE2_ARCHIVE_THEN_DELETE_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2ArchiveThenDeleteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_ARCHIVE_THEN_DELETE_PROMPT]);
  assertAssistantTextIncludes(projection, "archive then delete fixture complete");
  assert.isNotNull(projection.thread.archivedAt);
  assert.isNotNull(projection.thread.deletedAt);
  assert.lengthOf(
    projection.providerSessions,
    0,
    "detached sessions must stay out of the live providerSessions projection",
  );
  assert.isAtLeast(
    projection.providerThreads.filter((thread) => thread.providerSessionId !== null).length,
    1,
    "providerThreads must retain the historical providerSessionId for deletion",
  );

  const archivedIndex = result.domainEvents.findIndex(
    (event) => event.type === "thread.archived" && event.threadId === projection.thread.id,
  );
  const detachedAfterArchive = result.domainEvents.findIndex(
    (event, index) =>
      index > archivedIndex &&
      event.type === "provider-session.detached" &&
      event.threadId === projection.thread.id,
  );
  const deletedIndex = result.domainEvents.findIndex(
    (event) => event.type === "thread.deleted" && event.threadId === projection.thread.id,
  );
  const detachedAfterDelete = result.domainEvents.findIndex(
    (event, index) =>
      index > deletedIndex &&
      event.type === "provider-session.detached" &&
      event.threadId === projection.thread.id,
  );
  assert.isAtLeast(archivedIndex, 0, "archive must record thread.archived");
  assert.isAbove(
    detachedAfterArchive,
    archivedIndex,
    "archive must detach the live provider session",
  );
  assert.isAbove(deletedIndex, detachedAfterArchive, "delete must follow the archive detach");
  assert.isAbove(
    detachedAfterDelete,
    deletedIndex,
    "delete must detach the historically retained provider session",
  );

  const removeIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "session.remove",
  );
  assert.isAtLeast(
    removeIndex,
    0,
    "delete after archive must still remove the historically referenced native session",
  );
  assert.isFalse(result.shellSnapshot.threads.some((thread) => thread.id === projection.thread.id));
  assert.isFalse(
    result.shellSnapshot.archivedThreads.some((thread) => thread.id === projection.thread.id),
  );
}
