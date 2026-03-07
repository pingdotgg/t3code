import { describe, expect, it } from "vitest";

import {
  formatCopilotRequestCost,
  formatUsdAmount,
  getCopilotEstimatedOverageUsd,
  getCopilotModelMultiplier,
} from "./copilotBilling";

describe("copilotBilling", () => {
  it("returns the documented model multipliers", () => {
    expect(getCopilotModelMultiplier("gpt-5.4")).toBe(1);
    expect(getCopilotModelMultiplier("claude-haiku-4.5")).toBe(0.33);
    expect(getCopilotModelMultiplier("claude-opus-4.6-fast")).toBe(30);
    expect(getCopilotModelMultiplier("unknown-model")).toBeNull();
  });

  it("computes estimated overage costs per request", () => {
    expect(getCopilotEstimatedOverageUsd("gpt-5.4")).toBe(0.04);
    expect(getCopilotEstimatedOverageUsd("claude-haiku-4.5")).toBe(0.0132);
    expect(getCopilotEstimatedOverageUsd("claude-opus-4.6-fast")).toBe(1.2);
  });

  it("formats costs for display", () => {
    expect(formatUsdAmount(0.0132)).toBe("$0.013");
    expect(formatUsdAmount(1.2)).toBe("$1.20");
    expect(formatCopilotRequestCost("gpt-5.4")).toBe("1x · ~$0.04");
    expect(formatCopilotRequestCost("gpt-5-mini")).toBe("0x · included on paid plans");
  });
});
