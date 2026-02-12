import { describe, expect, it } from "vitest";

import { ProviderManager } from "./providerManager";

describe("ProviderManager", () => {
  it("detaches provider event listener and ends thread log streams on dispose", () => {
    const manager = new ProviderManager();
    const internals = manager as unknown as {
      codex: { listenerCount: (event: string) => number };
      onCodexEvent: (event: {
        id: string;
        kind: "notification";
        provider: "codex";
        sessionId: string;
        createdAt: string;
        method: string;
        threadId: string;
      }) => void;
      threadLogStreams: Map<string, { writableEnded: boolean; destroyed: boolean }>;
    };
    internals.onCodexEvent({
      id: "evt-1",
      kind: "notification",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: new Date().toISOString(),
      method: "thread/started",
      threadId: "thread-1",
    });
    const stream = internals.threadLogStreams.get("thread-1");
    expect(stream).toBeDefined();
    if (!stream) return;

    expect(internals.codex.listenerCount("event")).toBe(1);
    manager.dispose();

    expect(internals.codex.listenerCount("event")).toBe(0);
    expect(stream.writableEnded || stream.destroyed).toBe(true);
    expect(internals.threadLogStreams.size).toBe(0);
  });

  it("allows multiple dispose calls", () => {
    const manager = new ProviderManager();

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("rejects request responses for unknown sessions", async () => {
    const manager = new ProviderManager();

    await expect(
      manager.respondToRequest({
        sessionId: "missing-session",
        requestId: "req-1",
        decision: "accept",
      }),
    ).rejects.toThrow("Unknown provider session: missing-session");

    manager.dispose();
  });
});
