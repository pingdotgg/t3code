import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createRunningTerminalState } from "./terminal-running-state";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function makeSummaries(runningThreadIndexes: ReadonlySet<number>, onRead: () => void) {
  return Array.from({ length: 50 }, (_, index) => ({
    threadId: `thread-${index}`,
    get hasRunningSubprocess() {
      onRead();
      return runningThreadIndexes.has(index);
    },
  }));
}

describe("running terminal thread selectors", () => {
  it("scans metadata once per update and only publishes changed row booleans", () => {
    const metadataAtom = Atom.make(AsyncResult.success(makeSummaries(new Set(), () => {})));
    const state = createRunningTerminalState({ getMetadataAtom: () => metadataAtom });
    const registry = AtomRegistry.make();
    const notificationCounts = Array.from({ length: 30 }, () => 0);
    const unsubscribes = notificationCounts.map((_, index) =>
      registry.subscribe(
        state.threadHasRunningTerminalAtom(ENVIRONMENT_ID, ThreadId.make(`thread-${index}`)),
        () => {
          notificationCounts[index] += 1;
        },
        { immediate: true },
      ),
    );

    let summaryReads = 0;
    registry.set(
      metadataAtom,
      AsyncResult.success(makeSummaries(new Set([0]), () => (summaryReads += 1))),
    );

    expect(summaryReads).toBe(50);
    expect(notificationCounts[0]).toBe(2);
    expect(notificationCounts.slice(1)).toEqual(Array.from({ length: 29 }, () => 1));

    registry.set(
      metadataAtom,
      AsyncResult.success(makeSummaries(new Set([0, 49]), () => (summaryReads += 1))),
    );

    expect(summaryReads).toBe(100);
    expect(notificationCounts[0]).toBe(2);
    expect(notificationCounts.slice(1)).toEqual(Array.from({ length: 29 }, () => 1));

    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
    registry.dispose();
  });
});
