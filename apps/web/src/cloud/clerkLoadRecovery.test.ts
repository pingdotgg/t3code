import { describe, expect, it, vi } from "vite-plus/test";

import {
  type ClerkLoadRecoveryEnvironment,
  type ClerkStatusSource,
  watchClerkLoadRecovery,
} from "./clerkLoadRecovery";

type Status = Parameters<Parameters<ClerkStatusSource["on"]>[1]>[0];

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function setup(input: {
  readonly reachable: boolean;
  readonly storage?: Storage;
  /** Clerk's status before the watcher subscribes, replayed when it asks for `notify`. */
  readonly status?: Status;
}) {
  let handler: ((status: Status) => void) | null = null;
  const source: ClerkStatusSource = {
    on: (_event, next, options) => {
      handler = next;
      if (options?.notify && input.status !== undefined) next(input.status);
    },
    off: () => {
      handler = null;
    },
  };
  let trigger: (() => Promise<void>) | null = null;
  const state = { reachable: input.reachable, editing: false, failed: false };
  const storage = input.storage ?? createStorageStub();
  const reload = vi.fn();
  const environment: ClerkLoadRecoveryEnvironment = {
    probe: async () => state.reachable,
    reload,
    storage: () => storage,
    isEditing: () => state.editing,
    setFailed: (failed) => {
      state.failed = failed;
    },
    watchReachability: (next) => {
      trigger = next;
      return () => {
        trigger = null;
      };
    },
  };
  const stop = watchClerkLoadRecovery(source, environment);
  return {
    state,
    reload,
    storage,
    stop,
    emit: (status: Status) => handler?.(status),
    // Resolves once the probe a trigger starts has settled.
    fire: async () => {
      await trigger?.();
    },
    isWatching: () => trigger !== null,
  };
}

describe("watchClerkLoadRecovery", () => {
  it("reloads once Clerk is reachable again after it failed to load", async () => {
    // Clerk fails at startup, before the provider subscribes.
    const harness = setup({ reachable: false, status: "error" });
    expect(harness.state.failed).toBe(true);
    await harness.fire();
    expect(harness.reload).not.toHaveBeenCalled();

    harness.state.reachable = true;
    await harness.fire();
    expect(harness.reload).toHaveBeenCalledTimes(1);
    // The guard stops a second automatic reload in the same failure streak.
    await harness.fire();
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload under someone typing, and waits for the next chance", async () => {
    const harness = setup({ reachable: true });
    harness.state.editing = true;
    harness.emit("error");
    await harness.fire();
    expect(harness.reload).not.toHaveBeenCalled();

    harness.state.editing = false;
    await harness.fire();
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("stops after an automatic reload that still failed, until Clerk loads once", async () => {
    const storage = createStorageStub();
    const first = setup({ reachable: true, storage });
    first.emit("error");
    await first.fire();
    expect(first.reload).toHaveBeenCalledTimes(1);
    first.stop();

    // The page after the reload fails again: no reload loop.
    const second = setup({ reachable: true, storage });
    second.emit("error");
    await second.fire();
    expect(second.reload).not.toHaveBeenCalled();

    // A successful load clears the guard and the failed state.
    second.emit("ready");
    expect(second.state.failed).toBe(false);
    expect(second.isWatching()).toBe(false);
    second.emit("error");
    await second.fire();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });
});
