import { describe, expect, it } from "@effect/vitest";
import { AgentProfileId, AgentProfileRevision } from "@t3tools/contracts";

import { resolveAgentProfileSelection } from "./agentProfileSelection";

describe("agent profile selection", () => {
  it("preserves an explicit No agent selection", () => {
    expect(
      resolveAgentProfileSelection(null, {
        id: AgentProfileId.make("fallback"),
        scope: "environment",
        revision: AgentProfileRevision.make("a".repeat(64)),
      }),
    ).toBeNull();
  });

  it("falls back to the thread selection only when the draft is unset", () => {
    const fallback = {
      id: AgentProfileId.make("fallback"),
      scope: "environment" as const,
      revision: AgentProfileRevision.make("a".repeat(64)),
    };
    expect(resolveAgentProfileSelection(undefined, fallback)).toEqual(fallback);
  });
});
