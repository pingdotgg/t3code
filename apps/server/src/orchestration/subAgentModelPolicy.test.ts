import { describe, expect, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts";

import {
  enforceSubAgentStandardMode,
  isSubAgentThreadTitle,
  withSubAgentThreadTitle,
} from "./subAgentModelPolicy.ts";

describe("subAgentModelPolicy titles", () => {
  it("detects sub-agent thread titles", () => {
    expect(isSubAgentThreadTitle("Agent: reviewer")).toBe(true);
    expect(isSubAgentThreadTitle("  agent: reviewer")).toBe(true);
    expect(isSubAgentThreadTitle("Top-level agent discussion")).toBe(false);
  });

  it("normalizes titles to the Agent: prefix", () => {
    expect(withSubAgentThreadTitle("renamed reviewer")).toBe("Agent: renamed reviewer");
    expect(withSubAgentThreadTitle("agent: renamed reviewer")).toBe("Agent: renamed reviewer");
  });
});

describe("enforceSubAgentStandardMode", () => {
  const selection = (options?: ModelSelection["options"]): ModelSelection => ({
    instanceId: "claude" as ModelSelection["instanceId"],
    model: "claude-sonnet-5",
    ...(options !== undefined ? { options } : {}),
  });

  it("forces fast mode off and the standard service tier", () => {
    const result = enforceSubAgentStandardMode(
      selection([
        { id: "fastMode", value: true },
        { id: "serviceTier", value: "priority" },
      ]),
    );
    expect(result.options).toEqual([
      { id: "fastMode", value: false },
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("leaves unrelated options untouched", () => {
    const input = selection([{ id: "effort", value: "high" }]);
    expect(enforceSubAgentStandardMode(input)).toBe(input);
  });

  it("leaves selections without options untouched", () => {
    const input = selection();
    expect(enforceSubAgentStandardMode(input)).toBe(input);
  });
});
