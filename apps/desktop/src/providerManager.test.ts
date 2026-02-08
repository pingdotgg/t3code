import { describe, expect, it } from "vitest";

import { ProviderManager } from "./providerManager";

describe("ProviderManager", () => {
  it("detaches provider event listener and ends log stream on dispose", () => {
    const manager = new ProviderManager();
    const internals = manager as unknown as {
      codex: { listenerCount: (event: string) => number };
      logStream: { writableEnded: boolean; destroyed: boolean };
    };

    expect(internals.codex.listenerCount("event")).toBe(1);
    manager.dispose();

    expect(internals.codex.listenerCount("event")).toBe(0);
    expect(
      internals.logStream.writableEnded || internals.logStream.destroyed,
    ).toBe(true);
  });

  it("allows multiple dispose calls", () => {
    const manager = new ProviderManager();

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });
});
