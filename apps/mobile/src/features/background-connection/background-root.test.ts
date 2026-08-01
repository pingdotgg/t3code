import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const atoms = vi.hoisted(() => ({
  catalog: { name: "catalog" },
  serverConfigs: { name: "server-configs" },
  threadShells: { name: "thread-shells" },
  shellStates: new Map<string, { readonly name: string }>(),
  detailStates: new Map<string, { readonly name: string; readonly detailKey: string }>(),
}));

const retained = vi.hoisted(() => {
  const state: {
    snapshot: { loaded: boolean; thread: ScopedThreadRef | null };
    subscribeCount: number;
    releaseCount: number;
  } = {
    snapshot: { loaded: true, thread: null },
    subscribeCount: 0,
    releaseCount: 0,
  };
  const listeners = new Set<() => void>();
  const publish = (thread: ScopedThreadRef | null) => {
    state.snapshot = { loaded: true, thread };
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    state,
    listeners,
    publish,
    clear: vi.fn(async () => publish(null)),
    ensureLoaded: vi.fn(async () => state.snapshot.thread),
  };
});

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: atoms.catalog },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: atoms.serverConfigs,
}));

vi.mock("../../state/shell", () => ({
  environmentShell: {
    stateAtom: (environmentId: string) => {
      let atom = atoms.shellStates.get(environmentId);
      if (atom === undefined) {
        atom = { name: `shell:${environmentId}` };
        atoms.shellStates.set(environmentId, atom);
      }
      return atom;
    },
  },
}));

vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: atoms.threadShells },
  environmentThreads: {
    stateAtom: (environmentId: string, threadId: string) => {
      const key = `${environmentId}:${threadId}`;
      let atom = atoms.detailStates.get(key);
      if (atom === undefined) {
        atom = { name: `detail:${key}`, detailKey: key };
        atoms.detailStates.set(key, atom);
      }
      return atom;
    },
  },
}));

vi.mock("./retained-thread", () => ({
  clearBackgroundConnectionRetainedThread: retained.clear,
  ensureBackgroundConnectionRetainedThreadLoaded: retained.ensureLoaded,
  getBackgroundConnectionRetainedThreadSnapshot: () => retained.state.snapshot,
  subscribeBackgroundConnectionRetainedThread: (listener: () => void) => {
    retained.state.subscribeCount += 1;
    retained.listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retained.state.releaseCount += 1;
      retained.listeners.delete(listener);
    };
  },
}));

import { acquireBackgroundConnectionRoot, createBackgroundConnectionRoot } from "./background-root";

interface CatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentId, unknown>;
}

function atomName(atom: unknown): string {
  return (atom as { readonly name: string }).name;
}

function createRegistry(options: {
  readonly catalog: CatalogState;
  readonly threadShells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly deletedThreadKeys?: ReadonlySet<string>;
}) {
  let catalog = options.catalog;
  const threadShells = options.threadShells ?? [];
  const deletedThreadKeys = options.deletedThreadKeys ?? new Set<string>();
  const callbacks = new Map<unknown, Set<(value: unknown) => void>>();
  const mountCounts = new Map<string, number>();
  const mountReleaseCounts = new Map<string, number>();
  const subscribeCounts = new Map<string, number>();
  const subscribeReleaseCounts = new Map<string, number>();

  const increment = (counts: Map<string, number>, name: string) =>
    counts.set(name, (counts.get(name) ?? 0) + 1);
  const read = (atom: unknown): unknown => {
    if (atom === atoms.catalog) return catalog;
    if (atom === atoms.threadShells) return threadShells;
    const detailKey = (atom as { readonly detailKey?: string }).detailKey;
    if (detailKey !== undefined) {
      return AsyncResult.success({
        status: deletedThreadKeys.has(detailKey) ? "deleted" : "live",
      });
    }
    return null;
  };

  const registry = {
    get: read,
    mount(atom: unknown) {
      const name = atomName(atom);
      increment(mountCounts, name);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        increment(mountReleaseCounts, name);
      };
    },
    subscribe(
      atom: unknown,
      callback: (value: unknown) => void,
      subscribeOptions?: { readonly immediate?: boolean },
    ) {
      const name = atomName(atom);
      increment(subscribeCounts, name);
      const atomCallbacks = callbacks.get(atom) ?? new Set();
      atomCallbacks.add(callback);
      callbacks.set(atom, atomCallbacks);
      if (subscribeOptions?.immediate === true) {
        callback(read(atom));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        increment(subscribeReleaseCounts, name);
        atomCallbacks.delete(callback);
      };
    },
  } as unknown as AtomRegistry.AtomRegistry;

  return {
    registry,
    mountCount: (name: string) => mountCounts.get(name) ?? 0,
    mountReleaseCount: (name: string) => mountReleaseCounts.get(name) ?? 0,
    subscribeCount: (name: string) => subscribeCounts.get(name) ?? 0,
    subscribeReleaseCount: (name: string) => subscribeReleaseCounts.get(name) ?? 0,
    setCatalog(next: CatalogState) {
      catalog = next;
      for (const callback of callbacks.get(atoms.catalog) ?? []) {
        callback(catalog);
      }
    },
  };
}

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const retainedThread = { environmentId, threadId };

beforeEach(() => {
  retained.state.snapshot = { loaded: true, thread: retainedThread };
  retained.state.subscribeCount = 0;
  retained.state.releaseCount = 0;
  retained.listeners.clear();
  retained.clear.mockReset();
  retained.clear.mockImplementation(async () => retained.publish(null));
  retained.ensureLoaded.mockClear();
  atoms.shellStates.clear();
  atoms.detailStates.clear();
});

describe("background connection root", () => {
  it("starts and stops each lease exactly once", () => {
    const harness = createRegistry({
      catalog: { isReady: true, entries: new Map([[environmentId, {}]]) },
    });
    const root = createBackgroundConnectionRoot(harness.registry);

    root.start();
    root.start();

    expect(harness.mountCount("server-configs")).toBe(1);
    expect(harness.mountCount(`shell:${environmentId}`)).toBe(1);
    expect(harness.subscribeCount("catalog")).toBe(1);
    expect(harness.subscribeCount("thread-shells")).toBe(1);
    expect(harness.subscribeCount(`detail:${environmentId}:${threadId}`)).toBe(1);
    expect(retained.state.subscribeCount).toBe(1);

    root.stop();
    root.stop();

    expect(harness.mountReleaseCount("server-configs")).toBe(1);
    expect(harness.mountReleaseCount(`shell:${environmentId}`)).toBe(1);
    expect(harness.subscribeReleaseCount("catalog")).toBe(1);
    expect(harness.subscribeReleaseCount("thread-shells")).toBe(1);
    expect(harness.subscribeReleaseCount(`detail:${environmentId}:${threadId}`)).toBe(1);
    expect(retained.state.releaseCount).toBe(1);
  });

  it("shares one root until the final owner releases it", () => {
    const harness = createRegistry({
      catalog: { isReady: true, entries: new Map([[environmentId, {}]]) },
    });

    const releaseFirst = acquireBackgroundConnectionRoot(harness.registry);
    const releaseSecond = acquireBackgroundConnectionRoot(harness.registry);
    expect(harness.mountCount("server-configs")).toBe(1);

    releaseFirst();
    expect(harness.mountReleaseCount("server-configs")).toBe(0);
    releaseSecond();
    releaseSecond();
    expect(harness.mountReleaseCount("server-configs")).toBe(1);
  });

  it("clears a retained target when its environment is removed", () => {
    const harness = createRegistry({
      catalog: { isReady: true, entries: new Map([[environmentId, {}]]) },
    });
    const root = createBackgroundConnectionRoot(harness.registry);
    root.start();

    harness.setCatalog({ isReady: true, entries: new Map() });

    expect(retained.clear).toHaveBeenCalledOnce();
    expect(retained.state.snapshot.thread).toBeNull();
    expect(harness.subscribeReleaseCount(`detail:${environmentId}:${threadId}`)).toBe(1);
    root.stop();
  });

  it("clears and releases an immediately deleted retained thread", () => {
    const detailKey = `${environmentId}:${threadId}`;
    const harness = createRegistry({
      catalog: { isReady: true, entries: new Map([[environmentId, {}]]) },
      deletedThreadKeys: new Set([detailKey]),
    });
    const root = createBackgroundConnectionRoot(harness.registry);

    root.start();

    expect(retained.clear).toHaveBeenCalledOnce();
    expect(retained.state.snapshot.thread).toBeNull();
    expect(harness.subscribeCount(`detail:${detailKey}`)).toBe(1);
    expect(harness.subscribeReleaseCount(`detail:${detailKey}`)).toBe(1);
    root.stop();
  });

  it("re-clears a deleted ref saved while its first clear is pending", async () => {
    const firstClear = deferred();
    let clearCount = 0;
    retained.clear.mockImplementation(() => {
      retained.publish(null);
      clearCount += 1;
      return clearCount === 1 ? firstClear.promise : Promise.resolve();
    });
    const detailKey = `${environmentId}:${threadId}`;
    const harness = createRegistry({
      catalog: { isReady: true, entries: new Map([[environmentId, {}]]) },
      deletedThreadKeys: new Set([detailKey]),
    });
    const root = createBackgroundConnectionRoot(harness.registry);

    root.start();
    expect(retained.clear).toHaveBeenCalledOnce();

    retained.publish(retainedThread);
    expect(retained.clear).toHaveBeenCalledOnce();

    firstClear.resolve();
    await firstClear.promise;
    await Promise.resolve();

    expect(retained.clear).toHaveBeenCalledTimes(2);
    expect(retained.state.snapshot.thread).toBeNull();
    root.stop();
  });
});
