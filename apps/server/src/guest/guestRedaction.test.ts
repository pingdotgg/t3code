import {
  ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { guestHistoryPage, guestStreamItem } from "./guestRedaction.ts";

const SESSION_FILE = "/home/owner/.pi/agent/sessions/owner-session.jsonl";
const PROFILE_WARNING = "Profile owner-private-profile no longer exists.";
const nativeRef = { driver: "pi", nativeId: SESSION_FILE, strength: "strong" };
const WORKFLOW_SCRIPT = "/home/owner/.claude/workflows/owner-script.js";
const withProfile = { instanceId: "pi", model: "m", profileId: "owner-private-profile" };
const modelSwitch = {
  type: "user_message",
  modelSwitch: { from: withProfile, to: withProfile },
};
const handoff = { type: "handoff", fromModelSelections: [withProfile] };
const subagent = {
  id: "subagent-1",
  modelSelection: withProfile,
  workflow: {
    runHandles: { runId: "run-1", scriptPath: WORKFLOW_SCRIPT, transcriptDir: "/home/owner/t" },
    phases: [],
    agents: [],
  },
};
const profileError = {
  type: "error",
  title: ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE,
  failure: { class: "provider_error", message: PROFILE_WARNING, code: null, retryable: null },
};

// Only the records the scrub reads; the rest of each record passes through untouched.
const projection = {
  thread: { modelSelection: { instanceId: "pi", model: "m" }, branch: null, worktreePath: null },
  runs: [],
  attempts: [{ id: "attempt-1", nativeThreadId: SESSION_FILE }],
  subagents: [subagent],
  providerSessions: [],
  providerThreads: [
    { id: "pt-1", nativeThreadRef: nativeRef, nativeConversationHeadRef: nativeRef },
  ],
  providerTurns: [{ id: "turn-1", nativeTurnRef: nativeRef, nativeThreadRef: nativeRef }],
  turnItems: [profileError, modelSwitch, handoff],
  visibleTurnItems: [{ item: profileError }, { item: modelSwitch }, { item: handoff }],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
} as unknown as OrchestrationV2ThreadProjection;

const event = (type: string, payload: unknown) =>
  ({ kind: "event", sequence: 1, event: { type, payload } }) as OrchestrationV2ThreadStreamItem;

it("keeps profiles, native session paths and workflow files away from the guest", () => {
  const snapshot = guestStreamItem({ kind: "snapshot", snapshotSequence: 1, projection });
  const sent = [
    snapshot,
    guestStreamItem(event("provider-thread.updated", projection.providerThreads[0])),
    guestStreamItem(event("provider-turn.updated", projection.providerTurns[0])),
    guestStreamItem(event("run-attempt.updated", projection.attempts[0])),
    guestStreamItem(event("turn-item.updated", profileError)),
    guestStreamItem(event("turn-item.updated", modelSwitch)),
    guestStreamItem(event("subagent.updated", subagent)),
    guestHistoryPage({
      snapshotSequence: 1,
      items: [{ item: profileError }, { item: handoff }],
      nextCursor: null,
      hasMoreHistory: false,
      subagents: [subagent],
    } as never),
  ];
  const wire = JSON.stringify(sent);
  assert.notInclude(wire, SESSION_FILE);
  assert.notInclude(wire, "owner-private-profile");
  assert.notInclude(wire, WORKFLOW_SCRIPT);
  assert.notInclude(wire, "/home/owner/t");
  assert.include(wire, "run-1");
  // The reference itself stays: the reducer reads whether a provider thread has one.
  const ref =
    snapshot?.kind === "snapshot" ? snapshot.projection.providerThreads[0]?.nativeThreadRef : null;
  assert.strictEqual(ref?.driver, "pi");
  assert.isNull(ref?.nativeId);
  assert.include(wire, ORCHESTRATION_V2_SESSION_OPEN_FAILURE_TITLE);
});
