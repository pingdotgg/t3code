import { describe, expect, it } from "vite-plus/test";

import { makeProviderReplayGate } from "./replayGate.ts";

describe("makeProviderReplayGate", () => {
  it("holds a gated emit until its label is released", async () => {
    const gate = makeProviderReplayGate(["approval"]);
    let emitted = false;
    const emit = gate.beforeEmit("approval").then(() => {
      emitted = true;
    });

    expect(await gate.waitForReached("approval")).toBe(true);
    expect(emitted).toBe(false);
    expect(gate.release("approval")).toBe(true);
    await emit;
    expect(emitted).toBe(true);
    expect(gate.release("approval")).toBe(false);
  });

  it("passes ungated labels through and stops waiting when the emit is aborted", async () => {
    const gate = makeProviderReplayGate(["approval"]);
    await gate.beforeEmit(undefined);
    await gate.beforeEmit("other");

    const controller = new AbortController();
    const emit = gate.beforeEmit("approval", controller.signal);
    controller.abort();
    await emit;
    expect(gate.hasReached("approval")).toBe(true);
  });

  it("rejects duplicate labels", () => {
    expect(() => makeProviderReplayGate(["approval", "approval"])).toThrow(
      "Duplicate provider replay gate label approval.",
    );
  });
});
