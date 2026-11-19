import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AgentDefinition } from "./agentDefinition.ts";

const decodeAgentDefinition = Schema.decodeUnknownSync(AgentDefinition);

const reviewerFrontmatter = {
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews a diff for correctness bugs.",
  model: {
    provider: "codex",
    model: "gpt-5.4",
    options: { reasoningEffort: "high" },
  },
  tools: { deny: ["Bash"] },
  instructions: "Report concrete defects only.",
};

describe("AgentDefinition", () => {
  it("decodes authored frontmatter, mapping provider to the instance id", () => {
    const agent = decodeAgentDefinition(reviewerFrontmatter);

    expect(agent.model).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(agent).not.toHaveProperty("tools");
  });

  it("leaves the tier unset and defaults delegation to none when omitted", () => {
    const agent = decodeAgentDefinition({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews a diff for correctness bugs.",
      instructions: "Report concrete defects only.",
    });

    expect(agent.tier).toBeUndefined();
    expect(agent).not.toHaveProperty("tools");
    expect(agent.canDelegateTo).toEqual([]);
    expect(agent.model).toBeUndefined();
  });

  it.each(["Lead Agent", "lead_agent", "Lead", "-lead", "lead-"])("rejects agent id %s", (id) => {
    expect(() => decodeAgentDefinition({ ...reviewerFrontmatter, id })).toThrow();
  });

  it("rejects tiers outside economy and reasoning", () => {
    expect(() => decodeAgentDefinition({ ...reviewerFrontmatter, tier: "premium" })).toThrow();
  });
});
