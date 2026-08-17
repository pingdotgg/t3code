import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { waitForAtomValue } from "./waitForAtomValue";

describe("waitForAtomValue", () => {
  it("returns immediately when the current value is ready", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make("ready");

    await expect(
      waitForAtomValue({
        registry,
        atom,
        predicate: (value) => value === "ready",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(true);

    registry.dispose();
  });

  it("waits until a subscribed atom becomes ready", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make("pending");
    const result = waitForAtomValue({
      registry,
      atom,
      predicate: (value) => value === "ready",
      timeoutMs: 1_000,
    });

    registry.set(atom, "ready");

    await expect(result).resolves.toBe(true);
    registry.dispose();
  });

  it("returns false and unsubscribes when readiness times out", async () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = Atom.make("pending");
    const result = waitForAtomValue({
      registry,
      atom,
      predicate: (value) => value === "ready",
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe(false);
    registry.set(atom, "ready");
    registry.dispose();
    vi.useRealTimers();
  });
});
