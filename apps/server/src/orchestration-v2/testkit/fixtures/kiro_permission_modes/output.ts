import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { KIRO_PERMISSION_PROMPT } from "./input.ts";

interface Frame {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly configId?: unknown; readonly value?: unknown };
}

function frames(transcript: ProviderReplayTranscript) {
  return transcript.entries.flatMap((entry) =>
    entry.type === "runtime_exit" ? [] : [{ type: entry.type, frame: entry.frame as Frame }],
  );
}

function autopilotWrites(transcript: ProviderReplayTranscript) {
  return frames(transcript).flatMap(({ type, frame }) =>
    type === "expect_outbound" &&
    frame.kind === "request" &&
    frame.method === "session/set_config_option" &&
    frame.params?.configId === "autopilot"
      ? [frame.params.value]
      : [],
  );
}

interface PermissionParams {
  readonly toolCall?: { readonly title?: unknown };
  readonly _meta?: { readonly kiro?: { readonly type?: unknown } };
}

/** Kiro's permission requests in order: "tool" for a tool call, "turn" for its review of changes. */
function permissionRequestKinds(transcript: ProviderReplayTranscript) {
  return frames(transcript).flatMap(({ type, frame }) => {
    if (
      type !== "emit_inbound" ||
      frame.kind !== "request" ||
      frame.method !== "session/request_permission"
    ) {
      return [];
    }
    const params = frame.params as PermissionParams | undefined;
    return [params?._meta?.kiro?.type === "turn_approval" ? "turn" : "tool"];
  });
}

function assertCompletedWrite(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [KIRO_PERMISSION_PROMPT]);
  return projection;
}

/**
 * Supervised turns Kiro's Autopilot off. Kiro asks before the write and then
 * asks for a review of the turn's changes; both reach the user.
 */
export function assertKiroSupervisedWriteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertCompletedWrite(result, transcript);
  assert.deepEqual(autopilotWrites(transcript), ["off"], "Supervised turns Autopilot off");
  assert.deepEqual(permissionRequestKinds(transcript), ["tool", "turn"]);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.status),
    ["resolved", "resolved"],
    "the write and the review of changes both reach the user",
  );
}

/**
 * Full access keeps Kiro's Autopilot on, so Kiro skips its review of changes.
 * It still asks the client before the write, and T3 answers that by policy
 * without involving the user.
 */
export function assertKiroFullAccessWriteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertCompletedWrite(result, transcript);
  assert.deepEqual(autopilotWrites(transcript), [], "Kiro already opens on Autopilot");
  assert.deepEqual(permissionRequestKinds(transcript), ["tool"]);
  assert.lengthOf(projection.runtimeRequests, 0, "Full access never asks the user");
}
