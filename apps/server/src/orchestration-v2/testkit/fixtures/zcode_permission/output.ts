import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";

/**
 * Supervised: ZCode's `build` mode asks before the write and the command. The
 * approved write lands and the declined command never runs. Approval cards
 * offer no session choice, because ZCode's "always" answer is project-wide.
 */
export function assertZCodePermissionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const requests = projection.runtimeRequests.toSorted((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  assert.deepEqual(
    requests.map((request) => [request.status, request.decision]),
    [
      ["resolved", "accept"],
      ["resolved", "decline"],
    ],
  );
  for (const approval of projection.turnItems) {
    if (approval.type !== "approval_request") continue;
    assert.deepEqual(
      approval.options?.map((option) => option.decision),
      ["cancel", "decline", "accept"],
    );
  }

  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    Reflect.get(entry.frame, "method") === "session/request_permission"
      ? [Reflect.get(entry.frame, "result")]
      : [],
  );
  assert.deepEqual(frames, [
    { outcome: { outcome: "selected", optionId: "allow_once" } },
    { outcome: { outcome: "selected", optionId: "deny" } },
  ]);

  // Replay cannot write files, so the workspace check is ZCode's own report:
  // the approved write completed and the declined command did not run.
  const write = projection.turnItems.find((item) => item.type === "file_change");
  assert.equal(write?.status, "completed", "the approved write ran");
  const command = projection.turnItems.find((item) => item.type === "dynamic_tool");
  assert.equal(command?.status, "failed", "the declined command did not run");

  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );
  assert.deepEqual(answers, ["DONE", "REJECTED"], "ZCode's turn status line is not shown");
}
