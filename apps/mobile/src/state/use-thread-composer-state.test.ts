import { describe, expect, it } from "@effect/vitest";
import { AgentProfileId, AgentProfileRevision } from "@t3tools/contracts";

import { resolveAgentProfileSelection } from "./agentProfileSelection";

const profile = {
  id: AgentProfileId.make("reviewer"),
  scope: "environment" as const,
  revision: AgentProfileRevision.make("a".repeat(64)),
};

describe("thread composer agent profile selection", () => {
  it("preserves an explicit draft None selection", () => {
    expect(resolveAgentProfileSelection(null, profile)).toBeNull();
  });

  it("falls back only when the draft has no agent selection", () => {
    expect(resolveAgentProfileSelection(undefined, profile)).toEqual(profile);
    expect(resolveAgentProfileSelection(profile, null)).toEqual(profile);
  });
});
