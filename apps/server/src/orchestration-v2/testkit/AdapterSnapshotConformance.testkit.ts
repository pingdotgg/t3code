import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SteerInput,
  ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";

/** Observe the real adapter boundary without changing native frames or event delivery. */
export function makeAdapterSnapshotConformance() {
  const starts: Array<{ readonly input: ProviderAdapterV2TurnInput; succeeded: boolean }> = [];
  const events: Array<ProviderAdapterV2Event> = [];
  const steers: Array<{
    readonly input: ProviderAdapterV2SteerInput;
    readonly eventIndex: number;
  }> = [];
  const layer = Layer.effect(
    ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistryV2;
      return ProviderAdapterRegistryV2.of({
        ...registry,
        get: (instanceId) =>
          registry.get(instanceId).pipe(
            Effect.map((adapter) => ({
              ...adapter,
              openSession: (input) =>
                adapter.openSession(input).pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    events: runtime.events.pipe(
                      Stream.tap((event) => Effect.sync(() => events.push(event))),
                    ),
                    startTurn: (input) => {
                      const start = { input, succeeded: false };
                      starts.push(start);
                      return runtime.startTurn(input).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            start.succeeded = true;
                          }),
                        ),
                      );
                    },
                    steerTurn: (input) => {
                      steers.push({ input, eventIndex: events.length });
                      return runtime.steerTurn(input);
                    },
                  })),
                ),
            })),
          ),
      });
    }),
  );

  return {
    layer,
    assertConformance: () => {
      assert.isAbove(starts.length, 0, "the replay must start a real adapter attempt");
      const turnAttempts = new Map<string, ProviderAdapterV2TurnInput["attemptId"]>();
      for (const { input, succeeded } of starts) {
        const snapshotIndex = events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.runAttemptId === input.attemptId &&
            event.providerTurn.providerThreadId === input.providerThread.id &&
            event.providerTurn.nodeId === input.rootNodeId,
        );
        // A failed start with no native events is released by attempt ID on its error path.
        if (snapshotIndex === -1 && !succeeded) continue;
        assert.isAtLeast(snapshotIndex, 0, `missing root snapshot for ${input.attemptId}`);
        const snapshot = events[snapshotIndex];
        if (snapshot?.type !== "provider_turn.updated") return assert.fail("missing snapshot");
        const turnKey = `${input.providerThread.id}:${snapshot.providerTurn.id}`;
        const previousAttempt = turnAttempts.get(turnKey);
        assert.isTrue(
          previousAttempt === undefined || previousAttempt === input.attemptId,
          `distinct attempts must not reuse provider turn ${snapshot.providerTurn.id}`,
        );
        turnAttempts.set(turnKey, input.attemptId);
        const terminalIndex = events.findIndex(
          (event) =>
            event.type === "turn.terminal" &&
            event.providerThreadId === input.providerThread.id &&
            event.providerTurnId === snapshot.providerTurn.id,
        );
        // Some fixtures intentionally stop while native work is still running.
        if (terminalIndex !== -1) {
          const terminal = events[terminalIndex];
          assert.equal(
            terminal?.type === "turn.terminal" ? terminal.runOrdinal : undefined,
            input.runOrdinal,
          );
          assert.isBelow(
            snapshotIndex,
            terminalIndex,
            `root snapshot must precede the first terminal for ${input.attemptId}`,
          );
        }
      }
      for (const [terminalIndex, event] of events.entries()) {
        if (event.type !== "turn.terminal") continue;
        const threadStarts = starts.filter(
          ({ input }) => input.providerThread.id === event.providerThreadId,
        );
        if (threadStarts.length === 0) continue;
        const snapshotIndex = events.findIndex(
          (snapshot) =>
            snapshot.type === "provider_turn.updated" &&
            snapshot.providerTurn.providerThreadId === event.providerThreadId &&
            snapshot.providerTurn.id === event.providerTurnId,
        );
        assert.isAtLeast(snapshotIndex, 0, `terminal ${event.providerTurnId} has no snapshot`);
        const snapshot = events[snapshotIndex];
        if (snapshot?.type !== "provider_turn.updated") return assert.fail("missing snapshot");
        const rootStarts = threadStarts.filter(
          ({ input }) => input.rootNodeId === snapshot.providerTurn.nodeId,
        );
        if (rootStarts.length === 0) continue; // A subagent or imported turn is not this root.
        assert.isTrue(
          rootStarts.some(({ input }) => input.attemptId === snapshot.providerTurn.runAttemptId),
          `root terminal ${event.providerTurnId} must belong to its actual attempt`,
        );
        assert.isBelow(
          snapshotIndex,
          terminalIndex,
          `snapshot follows terminal ${event.providerTurnId}`,
        );
      }
      for (const { input, eventIndex } of steers) {
        assert.isTrue(
          events
            .slice(0, eventIndex)
            .some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.providerThreadId === input.providerThread.id &&
                event.providerTurn.id === input.providerTurnId &&
                starts.some(
                  ({ input: start }) => start.attemptId === event.providerTurn.runAttemptId,
                ),
            ),
          `ordinary steer must retain the admitted turn identity ${input.providerTurnId}`,
        );
      }
    },
  };
}
