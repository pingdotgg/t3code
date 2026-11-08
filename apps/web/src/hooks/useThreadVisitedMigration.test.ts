import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { makeThreadFixture } from "../test-fixtures";
import { startThreadVisitedMigration } from "./useThreadVisitedMigration";

const state = vi.hoisted(() => ({
  localVisits: {} as Record<string, string>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ threadLastVisitedAtById: state.localVisits }) },
}));
vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      threadShellsAtom: Atom.make<ReadonlyArray<EnvironmentThreadShell>>([]),
    },
    threadEnvironment: { visit: {} },
  };
});
vi.mock("../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    liveShellEnvironmentIdsAtom: Atom.make<ReadonlySet<EnvironmentId>>(new Set<EnvironmentId>()),
  };
});

const localVisit = "2026-10-27T10:00:00.000Z";

function setup(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  local = localVisit,
  live: ReadonlySet<EnvironmentId> = new Set(threads.map((thread) => thread.environmentId)),
) {
  state.localVisits = Object.fromEntries(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      local,
    ]),
  );
  vi.mocked(runAtomCommand).mockReset().mockResolvedValue(AsyncResult.success(undefined));
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const shells = environmentThreadShells.threadShellsAtom;
  if (!Atom.isWritable(shells)) throw new Error("Expected writable test shell state");
  const liveIds = liveShellEnvironmentIdsAtom;
  if (!Atom.isWritable(liveIds)) throw new Error("Expected writable test live state");
  registry.set(shells, threads);
  registry.set(liveIds, live);
  const stop = startThreadVisitedMigration(registry);
  const drain = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  return {
    setThreads(next: ReadonlyArray<EnvironmentThreadShell>) {
      registry.set(shells, next);
      drain();
    },
    setLive(next: ReadonlySet<EnvironmentId>) {
      registry.set(liveIds, next);
      drain();
    },
    [Symbol.dispose]() {
      stop();
      registry.dispose();
    },
  };
}

describe("startThreadVisitedMigration", () => {
  it("preserves mark unread when a client with a newer local visit reloads", () => {
    using _migration = setup([makeThreadFixture({ lastVisitedAt: "2026-10-27T09:59:59.999Z" })]);

    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("seeds unset visits once per environment and thread", () => {
    const thread = makeThreadFixture({ lastVisitedAt: null });
    const remote = { ...thread, environmentId: EnvironmentId.make("remote") };
    using migration = setup([thread, remote]);

    expect(vi.mocked(runAtomCommand).mock.calls.map((call) => call[2])).toEqual([
      {
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: localVisit },
      },
      {
        environmentId: remote.environmentId,
        input: { threadId: remote.id, visitedAt: localVisit },
      },
    ]);
    migration.setThreads([{ ...thread }, { ...remote }]);
    expect(runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("sends once the environment is live, and again after it resyncs", () => {
    const thread = makeThreadFixture({ lastVisitedAt: null });
    using migration = setup([thread], localVisit, new Set());
    expect(runAtomCommand).not.toHaveBeenCalled();

    migration.setLive(new Set([thread.environmentId]));
    expect(runAtomCommand).toHaveBeenCalledTimes(1);

    migration.setLive(new Set());
    migration.setLive(new Set([thread.environmentId]));
    expect(runAtomCommand).toHaveBeenCalledTimes(2);

    // Disabling an environment drops its threads before the hook sees them offline.
    migration.setThreads([]);
    migration.setLive(new Set());
    migration.setLive(new Set([thread.environmentId]));
    migration.setThreads([thread]);
    expect(runAtomCommand).toHaveBeenCalledTimes(3);
  });

  it("waits for older servers to support visits before migrating", () => {
    const thread = makeThreadFixture();
    expect(thread.lastVisitedAt).toBeUndefined();
    using migration = setup([thread]);
    expect(runAtomCommand).not.toHaveBeenCalled();

    migration.setThreads([{ ...thread, lastVisitedAt: null }]);
    expect(runAtomCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["", "not-a-date"])("ignores invalid local visits: %s", (local) => {
    using _migration = setup([makeThreadFixture({ lastVisitedAt: null })], local);
    expect(runAtomCommand).not.toHaveBeenCalled();
  });
});
