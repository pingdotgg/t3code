import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
  AccessibilityInfo: { addEventListener: () => ({ remove: () => undefined }) },
}));

import { makePermissionStatusAtom } from "./permissionStatusAtom";

function deferredReads() {
  const pending: Array<(status: string) => void> = [];
  return {
    read: () => new Promise<string>((resolve) => pending.push(resolve)),
    resolveNext: async (status: string) => {
      pending.shift()?.(status);
      await Promise.resolve();
    },
    get count() {
      return pending.length;
    },
  };
}

function makeRegistry() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => undefined;
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  return { registry, flush };
}

describe("makePermissionStatusAtom", () => {
  it("reads on mount and again each time the app returns to the foreground", async () => {
    const reads = deferredReads();
    const atom = makePermissionStatusAtom({ label: "test", initial: "checking", read: reads.read });
    const { registry, flush } = makeRegistry();
    const unmount = registry.mount(atom);

    expect(registry.get(atom)).toBe("checking");
    await reads.resolveNext("ask");
    expect(registry.get(atom)).toBe("ask");

    for (const listener of native.listeners) listener("background");
    expect(reads.count).toBe(0);
    for (const listener of native.listeners) listener("active");
    await reads.resolveNext("granted");
    expect(registry.get(atom)).toBe("granted");

    unmount();
    flush();
    expect(native.listeners.size).toBe(0);
  });

  it("stores a request's outcome", () => {
    const reads = deferredReads();
    const atom = makePermissionStatusAtom({ label: "test", initial: "checking", read: reads.read });
    const { registry, flush } = makeRegistry();
    const unmount = registry.mount(atom);

    registry.set(atom, "denied");
    expect(registry.get(atom)).toBe("denied");

    unmount();
    flush();
  });
});
