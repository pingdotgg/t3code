import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { MUSE_PERMISSION_APPROVED_FILE, MUSE_PERMISSION_DECLINED_FILE } from "./input.ts";

/**
 * Supervised: both commands ask first. The approved one runs. Decline answers
 * with Muse's Reject (`abort`) choice, so the command never runs and the turn
 * still settles instead of waiting on an answer Muse cannot accept.
 */
export function assertMusePermissionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assert.lengthOf(projection.runs, 2);
  assert.equal(projection.runs[0]?.status, "completed");
  assert.include(["completed", "interrupted"], projection.runs[1]?.status);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: projection.runs.map((run) => run.status),
  });

  const requests = projection.runtimeRequests.toSorted((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  assert.deepEqual(
    requests.map((request) => [request.kind, request.status, request.decision]),
    [
      ["command", "resolved", "accept"],
      ["command", "resolved", "decline"],
    ],
  );
  const approval = projection.turnItems.find((item) => item.type === "approval_request");
  const options = approval?.type === "approval_request" ? (approval.options ?? []) : [];
  // Reject is offered as the decline button, not hidden behind "cancel".
  assert.includeDeepMembers(
    options.map((option) => option.decision),
    ["accept", "decline"],
  );
  assert.notInclude(
    options.map((option) => option.decision),
    "cancel",
  );

  const decisions = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "approval/decide"
      ? [Reflect.get(Reflect.get(entry.frame, "params") as object, "choiceId")]
      : [],
  );
  assert.deepEqual(decisions, ["allow_once", "abort"]);

  const shells = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.isTrue(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(MUSE_PERMISSION_APPROVED_FILE) &&
        item.status === "completed",
    ),
  );
  assert.isFalse(
    shells.some(
      (item) =>
        item.type === "command_execution" &&
        item.input.includes(MUSE_PERMISSION_DECLINED_FILE) &&
        item.status === "completed",
    ),
  );
}
