import { observeAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { environmentThreadShells } from "../state/threads";
import { makeThreadFixture } from "../test-fixtures";
import { startThreadVisitedMigration } from "./useThreadVisitedMigration";

const state = vi.hoisted(() => ({
  localVisits: {} as Record<string, string>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  observeAtomCommand: vi.fn(),
}));
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

const localVisit = "2026-10-27T10:00:00.000Z";

function setup(threads: ReadonlyArray<EnvironmentThreadShell>, local = localVisit) {
  state.localVisits = Object.fromEntries(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      local,
    ]),
  );
  vi.mocked(observeAtomCommand)
    .mockReset()
    .mockReturnValue(Effect.succeed(AsyncResult.success(undefined)));
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const shells = environmentThreadShells.threadShellsAtom;
  if (!Atom.isWritable(shells)) throw new Error("Expected writable test shell state");
  registry.set(shells, threads);
  const stop = startThreadVisitedMigration(registry);
  return {
    setThreads(next: ReadonlyArray<EnvironmentThreadShell>) {
      registry.set(shells, next);
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
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

    expect(observeAtomCommand).not.toHaveBeenCalled();
  });

  it("seeds unset visits once per environment and thread", () => {
    const thread = makeThreadFixture({ lastVisitedAt: null });
    const remote = { ...thread, environmentId: EnvironmentId.make("remote") };
    using migration = setup([thread, remote]);

    expect(vi.mocked(observeAtomCommand).mock.calls.map((call) => call[2])).toEqual([
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
    expect(observeAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("waits for older servers to support visits before migrating", () => {
    const thread = makeThreadFixture();
    expect(thread.lastVisitedAt).toBeUndefined();
    using migration = setup([thread]);
    expect(observeAtomCommand).not.toHaveBeenCalled();

    migration.setThreads([{ ...thread, lastVisitedAt: null }]);
    expect(observeAtomCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["", "not-a-date"])("ignores invalid local visits: %s", (local) => {
    using _migration = setup([makeThreadFixture({ lastVisitedAt: null })], local);
    expect(observeAtomCommand).not.toHaveBeenCalled();
  });
});
