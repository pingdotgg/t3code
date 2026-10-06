import { assert } from "@effect/vitest";

import type { ProviderAdapterV2Event, ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";

type AttemptIdentity = Pick<
  ProviderAdapterV2TurnInput,
  "providerThread" | "runId" | "runOrdinal" | "rootNodeId" | "attemptId"
>;

/** A restart reuses the durable run while each native attempt has its own terminal identity. */
export function assertRestartSnapshotConformance(
  events: ReadonlyArray<ProviderAdapterV2Event>,
  first: AttemptIdentity,
  replacement: AttemptIdentity,
) {
  assert.equal(replacement.providerThread.id, first.providerThread.id);
  assert.equal(replacement.runId, first.runId);
  assert.equal(replacement.runOrdinal, first.runOrdinal);
  assert.equal(replacement.rootNodeId, first.rootNodeId);
  assert.notEqual(replacement.attemptId, first.attemptId);
  const turns = [first, replacement].map((input) => {
    const snapshotIndex = events.findIndex(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.providerTurn.runAttemptId === input.attemptId &&
        event.providerTurn.providerThreadId === input.providerThread.id &&
        event.providerTurn.nodeId === input.rootNodeId,
    );
    assert.isAtLeast(snapshotIndex, 0, `missing root snapshot for ${input.attemptId}`);
    const snapshot = events[snapshotIndex];
    if (snapshot?.type !== "provider_turn.updated") return assert.fail("missing snapshot");
    const terminalIndex = events.findIndex(
      (event) =>
        event.type === "turn.terminal" &&
        event.providerThreadId === input.providerThread.id &&
        event.providerTurnId === snapshot.providerTurn.id,
    );
    assert.isAtLeast(terminalIndex, 0, `missing terminal for ${input.attemptId}`);
    assert.isBelow(
      snapshotIndex,
      terminalIndex,
      `snapshot follows terminal for ${input.attemptId}`,
    );
    return snapshot.providerTurn.id;
  });
  assert.notEqual(turns[0], turns[1], "replacement must have a distinct native terminal identity");
}
