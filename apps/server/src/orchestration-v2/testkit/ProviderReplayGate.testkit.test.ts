import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./ProviderReplayGate.testkit.ts";

describe("ProviderReplayGate", () => {
  it("signals arrival before the held frame is released", async () => {
    const label = "held-frame";
    const gate = makeProviderReplayGate([label]);
    const reached = gate.waitForReached(label);
    let emitted = false;
    const emission = gate.beforeEmit(label).then(() => {
      emitted = true;
    });

    expect(await reached).toBe(true);
    expect(emitted).toBe(false);
    gate.release(label);
    await emission;
    expect(emitted).toBe(true);
    expect(await gate.waitForReached(label)).toBe(true);
    expect(await gate.waitForReached("unknown-frame")).toBe(false);
  });

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
