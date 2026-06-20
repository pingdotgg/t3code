import { describe, expect, it } from "vite-plus/test";

import { observeAutomationOwnerConnectedGeneration } from "./PreviewAutomationOwner";

describe("observeAutomationOwnerConnectedGeneration", () => {
  it("reports ownership when the initial transport generation connects", () => {
    const initial = observeAutomationOwnerConnectedGeneration(null, 1);
    expect(initial).toEqual({
      nextGeneration: 1,
      shouldReport: true,
    });

    const disconnected = observeAutomationOwnerConnectedGeneration(initial.nextGeneration, null);
    expect(disconnected).toEqual({
      nextGeneration: 1,
      shouldReport: false,
    });

    expect(observeAutomationOwnerConnectedGeneration(disconnected.nextGeneration, 2)).toEqual({
      nextGeneration: 2,
      shouldReport: true,
    });
  });

  it("does not re-report for repeated connected state from the same generation", () => {
    expect(observeAutomationOwnerConnectedGeneration(3, 3)).toEqual({
      nextGeneration: 3,
      shouldReport: false,
    });
  });
});
