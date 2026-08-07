import { describe, expect, it } from "@effect/vitest";

import type { ProviderAdapterCapabilities } from "./Services/ProviderAdapter.ts";
import { resolveAgentRuntimeCompatibility } from "./AgentRuntimeCompatibility.ts";

const portable: ProviderAdapterCapabilities = {
  sessionModelSwitch: "in-session",
  agentRuntime: {
    mcpServerInjection: true,
    instructionDelivery: "prompt",
    nativeToolPolicy: "sandbox-only",
    tokenUsage: true,
    monetaryCost: false,
  },
};

it("accepts portable prompt and sandbox requirements", () => {
  expect(
    resolveAgentRuntimeCompatibility(portable, {
      delegation: true,
      instructionPriority: "prompt",
      nativeToolPolicy: "sandbox",
      tokenBudget: true,
      monetaryBudget: false,
    }),
  ).toEqual({ compatible: true, issues: [] });
});

it("blocks guarantees the adapter cannot enforce", () => {
  expect(
    resolveAgentRuntimeCompatibility(portable, {
      delegation: true,
      instructionPriority: "system-required",
      nativeToolPolicy: "exact",
      tokenBudget: true,
      monetaryBudget: true,
    }),
  ).toEqual({
    compatible: false,
    issues: [
      "system-instructions-unsupported",
      "exact-tool-policy-unsupported",
      "monetary-accounting-unsupported",
    ],
  });
});

describe("legacy adapters", () => {
  it("are incompatible until they explicitly declare Agent guarantees", () => {
    expect(
      resolveAgentRuntimeCompatibility(
        { sessionModelSwitch: "in-session" },
        {
          delegation: false,
          instructionPriority: "prompt",
          nativeToolPolicy: "none",
          tokenBudget: false,
          monetaryBudget: false,
        },
      ),
    ).toEqual({ compatible: false, issues: ["agent-runtime-undeclared"] });
  });
});
