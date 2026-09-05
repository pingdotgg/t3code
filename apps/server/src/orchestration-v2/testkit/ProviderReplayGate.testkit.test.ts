import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

describe("ProviderReplayGate", () => {
  it("stops waiting when the replay consumer is interrupted", async () => {
    const label = "held-frame";
    const gate = makeProviderReplayGate([label]);
    const controller = new AbortController();
    const waiting = gate.beforeEmit(label, controller.signal);

    expect(gate.hasReached(label)).toBe(true);
    controller.abort();
    await waiting;
    expect(gate.release(label)).toBe(true);
  });
});
