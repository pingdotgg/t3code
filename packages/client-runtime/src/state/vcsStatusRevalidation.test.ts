import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVcsStatusRevalidationAtomFamily } from "./vcsStatusRevalidation.ts";

const environmentId = EnvironmentId.make("environment-1");

function setup(options: { readonly connected?: boolean; readonly wake?: boolean }) {
  const connectedAtom = Atom.make(options.connected ?? false);
  const wakes = new Set<() => void>();
  const run = vi.fn(async () => AsyncResult.success(null));
  const family = createVcsStatusRevalidationAtomFamily({
    refreshStatus: { label: "refresh-status", run },
    ...(options.connected === undefined ? {} : { connected: () => connectedAtom }),
    ...(options.wake
      ? {
          subscribeWake: (wake: () => void) => {
            wakes.add(wake);
            return () => wakes.delete(wake);
          },
          wakeDebounceMs: 250,
        }
      : {}),
  });
  const registry = AtomRegistry.make();
  const wake = () => {
    for (const listener of wakes) listener();
  };
  return { registry, family, connectedAtom, run, wakes, wake };
}

describe("createVcsStatusRevalidationAtomFamily", () => {
  it("refreshes once per connection, shared by every subscriber, and again on reconnect", () => {
    const { registry, family, connectedAtom, run } = setup({ connected: true });
    const target = { environmentId, cwd: "/repo" };
    const first = registry.mount(family(target));
    const second = registry.mount(family({ environmentId, cwd: "/repo" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), { environmentId, input: { cwd: "/repo" } });

    registry.set(connectedAtom, false);
    expect(run).toHaveBeenCalledTimes(1);
    registry.set(connectedAtom, true);
    expect(run).toHaveBeenCalledTimes(2);

    registry.mount(family({ environmentId, cwd: "/other" }))();
    expect(run).toHaveBeenCalledTimes(3);
    first();
    second();
  });

  it("waits for the connection before the first refresh", () => {
    const { registry, family, connectedAtom, run } = setup({ connected: false });
    const unmount = registry.mount(family({ environmentId, cwd: "/repo" }));
    expect(run).not.toHaveBeenCalled();
    registry.set(connectedAtom, true);
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("debounces wake signals and stops listening with the last subscriber", () => {
    vi.useFakeTimers();
    try {
      const { registry, family, run, wakes, wake } = setup({ wake: true });
      const unmount = registry.mount(family({ environmentId, cwd: "/repo" }));
      expect(run).not.toHaveBeenCalled();

      wake();
      vi.advanceTimersByTime(100);
      wake();
      vi.advanceTimersByTime(249);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);

      wake();
      unmount();
      vi.runAllTimers();
      expect(run).toHaveBeenCalledTimes(1);
      expect(wakes.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing for an idle target", () => {
    const { registry, family, run, wakes } = setup({ connected: true, wake: true });
    registry.mount(family(null))();
    expect(run).not.toHaveBeenCalled();
    expect(wakes.size).toBe(0);
  });
});
