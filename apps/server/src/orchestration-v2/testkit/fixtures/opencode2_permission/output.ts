import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_PERMISSION_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * Supervised: each shell call asks. The approved one runs; the declined one and
 * the model's two retries fail without running, and the turn still completes.
 */
export function assertOpenCode2PermissionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_PERMISSION_PROMPT]);

  const requests = projection.runtimeRequests.toSorted((left, right) =>
    left.createdAt < right.createdAt ? -1 : 1,
  );
  assert.deepEqual(
    requests.map((request) => [request.kind, request.status, request.decision]),
    [
      ["command", "resolved", "accept"],
      ["command", "resolved", "decline"],
      ["command", "resolved", "decline"],
      ["command", "resolved", "decline"],
    ],
  );
  assert.deepEqual(
    requests.map((request) => request.nativeRequestRef?.nativeId),
    [
      "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
      "per_0eb7c5376001gkpJzQEeWtaoRE",
      "per_0eb7c5b1f001zGfBgDhzxz8z10",
      "per_0eb7c6755001DdRDvkLLSYU4BD",
    ],
  );

  const approvals = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.deepEqual(
    approvals.map((item) => [item.status, item.type === "approval_request" ? item.prompt : null]),
    [
      ["completed", "echo FIRST"],
      ["cancelled", "echo SECOND"],
      ["cancelled", "echo SECOND"],
      ["cancelled", "echo THIRD_PROBE"],
    ],
  );
  // "Always" is this session's own rule, not OpenCode's project-wide grant.
  const options = approvals[0]?.type === "approval_request" ? (approvals[0].options ?? []) : [];
  assert.deepInclude(options, {
    decision: "acceptForSession",
    label: "Allow echo * this session",
  });

  const shells = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.deepEqual(
    shells.map((item) => [
      item.type === "command_execution" ? item.input : null,
      item.status,
      item.type === "command_execution" ? item.output : null,
    ]),
    [
      ["echo FIRST", "completed", "FIRST\n"],
      ["echo SECOND", "failed", "Unable to execute command: echo SECOND"],
      ["echo SECOND", "failed", "Unable to execute command: echo SECOND"],
      ["echo THIRD_PROBE", "failed", "Unable to execute command: echo THIRD_PROBE"],
    ],
  );
}
