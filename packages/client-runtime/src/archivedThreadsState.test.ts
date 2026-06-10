import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ArchivedThreadsClient,
  createArchivedThreadsManager,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
  readArchivedThreadsSnapshotState,
} from "./archivedThreadsState.ts";

let registry = AtomRegistry.make();

function resetAtomRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

function createSnapshot(id: string): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [],
    updatedAt: `2026-05-08T00:00:00.000Z`,
    id,
  } as OrchestrationShellSnapshot;
}

describe("createArchivedThreadsManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("loads archived snapshots for configured environment clients", async () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const clients = new Map<EnvironmentId, ArchivedThreadsClient>([
      [
        envA,
        {
          getArchivedShellSnapshot: vi.fn(async () => createSnapshot("a")),
        },
      ],
      [
        envB,
        {
          getArchivedShellSnapshot: vi.fn(async () => createSnapshot("b")),
        },
      ],
    ]);
    const manager = createArchivedThreadsManager({
      getRegistry: () => registry,
      getClient: (environmentId) => clients.get(environmentId) ?? null,
    });

    const result = registry.get(manager.getAtom(makeArchivedThreadsEnvironmentKey([envB, envA])));

    await vi.waitFor(() => {
      const state = readArchivedThreadsSnapshotState(
        registry.get(manager.getAtom(makeArchivedThreadsEnvironmentKey([envA, envB]))),
      );
      expect(state.snapshots.map((snapshot) => snapshot.environmentId)).toEqual([envA, envB]);
    });
    expect(readArchivedThreadsSnapshotState(result).isLoading).toBe(true);
  });

  it("refreshes known snapshot groups that include an environment", async () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const getArchivedShellSnapshot = vi.fn(async () =>
      createSnapshot(`a-${getArchivedShellSnapshot.mock.calls.length}`),
    );
    const manager = createArchivedThreadsManager({
      getRegistry: () => registry,
      getClient: (environmentId) => (environmentId === envA ? { getArchivedShellSnapshot } : null),
      staleTimeMs: 60_000,
    });

    const atom = manager.getAtom(makeArchivedThreadsEnvironmentKey([envA, envB]));
    registry.get(atom);
    await vi.waitFor(() => expect(getArchivedShellSnapshot).toHaveBeenCalledTimes(1));

    manager.refreshForEnvironment(envA);

    await vi.waitFor(() => expect(getArchivedShellSnapshot).toHaveBeenCalledTimes(2));
  });

  it("round-trips environment keys in sorted order", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

    expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
  });
});
