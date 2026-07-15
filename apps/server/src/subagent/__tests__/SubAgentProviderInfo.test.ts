import { describe, it, expect } from "vite-plus/test";
import { getModelCostTier, getProviderCostTier } from "../SubAgentProviderInfo.ts";

describe("SubAgentProviderInfo", () => {
  it("should classify cheap models correctly", () => {
    expect(getModelCostTier("claude-haiku-4.5")).toBe("cheap");
    expect(getModelCostTier("gpt-4o-mini")).toBe("cheap");
  });

  it("should classify moderate models correctly", () => {
    expect(getModelCostTier("claude-sonnet-5")).toBe("moderate");
    expect(getModelCostTier("gpt-4o")).toBe("moderate");
  });

  it("should classify expensive models correctly", () => {
    expect(getModelCostTier("claude-fable-5")).toBe("expensive");
    expect(getModelCostTier("claude-opus-4.8")).toBe("expensive");
    expect(getModelCostTier("gpt-5.5")).toBe("expensive");
  });

  it("should default unknown models to moderate", () => {
    expect(getModelCostTier("unknown-model-xyz")).toBe("moderate");
  });

  it("should mark opencode as api-credits", () => {
    expect(getProviderCostTier("opencode")).toBe("api-credits");
  });

  it("should mark other providers as subscription", () => {
    expect(getProviderCostTier("codex")).toBe("subscription");
    expect(getProviderCostTier("claudeAgent")).toBe("subscription");
  });

  it("should default unknown providers to subscription", () => {
    expect(getProviderCostTier("unknown-provider")).toBe("subscription");
  });
});
