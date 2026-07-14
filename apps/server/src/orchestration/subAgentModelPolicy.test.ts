import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  enforceSubAgentStandardMode,
  isSubAgentThreadTitle,
  withSubAgentThreadTitle,
} from "./subAgentModelPolicy.ts";

it("recognizes product-native sub-agent thread titles", () => {
  expect(isSubAgentThreadTitle("Agent: reviewer")).toBe(true);
  expect(isSubAgentThreadTitle("  agent: reviewer")).toBe(true);
  expect(isSubAgentThreadTitle("Top-level agent discussion")).toBe(false);
  expect(withSubAgentThreadTitle("renamed reviewer")).toBe("Agent: renamed reviewer");
  expect(withSubAgentThreadTitle("agent: renamed reviewer")).toBe("Agent: renamed reviewer");
});

it("forces both Claude fast mode and Codex priority tier to standard", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
      { id: "serviceTier", value: "priority" },
    ],
  };

  expect(enforceSubAgentStandardMode(selection)).toEqual({
    ...selection,
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
      { id: "serviceTier", value: "default" },
    ],
  });
});

it("leaves top-level-compatible selections without fast controls unchanged", () => {
  const selection: ModelSelection = {
    instanceId: ProviderInstanceId.make("claudex"),
    model: "claudex-sol",
    options: [{ id: "effort", value: "high" }],
  };

  expect(enforceSubAgentStandardMode(selection)).toBe(selection);
});
