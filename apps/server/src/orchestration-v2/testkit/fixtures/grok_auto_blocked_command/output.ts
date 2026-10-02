import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoAcpClientFileOrTerminalRequests,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  GROK_AUTO_BLOCKED_COMMAND_PROMPT,
  GROK_AUTO_BLOCKED_PATH,
  GROK_AUTO_PENDING_SHELL_KEY,
  GROK_AUTO_ROUTINE_MARKER,
} from "./input.ts";

interface Frame {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly _meta?: unknown; readonly toolCall?: unknown };
  readonly result?: unknown;
}

// Grok's Auto mode runs routine commands on its own classifier's say-so and
// asks about the ones it holds, but only a client declaring a prompting type
// gets asked; any other client gets a silent "Auto mode blocked this action".
// T3 must then leave that question to the user instead of answering it by
// its own policy, which would approve it in Auto mode.
export function assertGrokAutoBlockedCommandOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [GROK_AUTO_BLOCKED_COMMAND_PROMPT]);
  assertNoAcpClientFileOrTerminalRequests(transcript);

  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "runtime_exit" ? [] : [{ type: entry.type, frame: entry.frame as Frame }],
  );
  assert.deepEqual(
    frames.find(({ frame }) => frame.method === "initialize")?.frame.params?._meta,
    { clientType: "extension" },
    "T3 must tell Grok it can show permission prompts",
  );

  const commands = projection.turnItems.flatMap((item) =>
    item.type === "command_execution" ? [item] : [],
  );
  const routine = commands.find((item) => item.input.includes(GROK_AUTO_ROUTINE_MARKER));
  assert.equal(routine?.status, "completed", "the routine command must run");
  const blocked = commands.find((item) => item.input.includes(GROK_AUTO_BLOCKED_PATH));
  assert.equal(blocked?.status, "completed", "the approved command must run");

  // Only the blocked command asks; the routine one never does.
  const permissionCommands = frames.flatMap(({ type, frame }) =>
    type === "emit_inbound" && frame.method === "session/request_permission"
      ? [JSON.stringify(frame.params?.toolCall)]
      : [],
  );
  assert.lengthOf(permissionCommands, 1, "Grok must ask about exactly one command");
  assert.include(permissionCommands[0], GROK_AUTO_BLOCKED_PATH);
  assert.notInclude(permissionCommands[0], GROK_AUTO_ROUTINE_MARKER);

  assert.lengthOf(projection.runtimeRequests, 1);
  const request = projection.runtimeRequests[0]!;
  assert.equal(request.kind, "command");
  assert.equal(request.status, "resolved");
  assert.equal(request.decision, "accept");
  const pendingShell = result.capturedShellSnapshots.get(GROK_AUTO_PENDING_SHELL_KEY);
  assert.equal(
    pendingShell?.threads.find((thread) => thread.id === projection.thread.id)
      ?.pendingRuntimeRequest?.id,
    request.id,
    "the blocked command must wait on the user as a pending request",
  );
  const answer = frames.find(
    ({ type, frame }) =>
      type === "expect_outbound" &&
      frame.kind === "response" &&
      frame.method === "session/request_permission",
  )?.frame.result;
  assert.deepEqual(answer, { outcome: { outcome: "selected", optionId: "allow-once" } });

  // Grok's bash prompt offers `always-allow`, which it saves for the whole
  // project, not the session. The card must not offer it as a session choice.
  const approval = projection.turnItems.find(
    (item) => item.type === "approval_request" && item.requestId === request.id,
  );
  assert.deepEqual(
    approval?.type === "approval_request" ? approval.options?.map((option) => option.decision) : [],
    ["cancel", "decline", "accept"],
  );
}
