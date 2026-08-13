import { describe, expect, it } from "vite-plus/test";

import {
  AETHER_AGENT_TYPES,
  AETHER_DEFAULT_AGENT_TYPE,
  AETHER_PLATFORM_CATALOG,
  defaultReasoningEffortForModel,
  reasoningEffortsForModel,
} from "./catalog.ts";

describe("AETHER_PLATFORM_CATALOG", () => {
  it("keeps the codex and claude families", () => {
    expect(AETHER_AGENT_TYPES).toEqual(["codex", "claude-code"]);
    expect(AETHER_DEFAULT_AGENT_TYPE).toBe("codex");
  });

  it("declares a default model that exists in each agent's model list", () => {
    for (const agentType of AETHER_AGENT_TYPES) {
      const agent = AETHER_PLATFORM_CATALOG.agents[agentType];
      expect(agent.models.length).toBeGreaterThan(0);
      expect(agent.models.map((model) => model.slug)).toContain(agent.defaultModel);
    }
  });

  it("offers only selectable reasoning efforts, non-empty for grouped models", () => {
    for (const agentType of AETHER_AGENT_TYPES) {
      const group = AETHER_PLATFORM_CATALOG.reasoningEffort[agentType];
      const selectable = new Set(group.selectableOptions);
      for (const model of AETHER_PLATFORM_CATALOG.agents[agentType].models) {
        const efforts = reasoningEffortsForModel(agentType, model.slug);
        const inModelGroup = group.modelOptions.some((entry) => entry.models.includes(model.slug));
        // Grouped models offer their group; a model in NO group gets NO
        // efforts — upstream (domain-types model.ts / Go catalog) resolves
        // nil options and the Aether API 400s any reasoning_effort for it.
        if (inModelGroup) {
          expect(efforts.length).toBeGreaterThan(0);
        } else {
          expect(efforts).toEqual([]);
        }
        // Every offered effort must be selectable — Aether 422s on the rest.
        for (const effort of efforts) {
          expect(selectable.has(effort)).toBe(true);
        }
      }
    }
  });

  it("resolves a default effort inside each model's offered set, none when empty", () => {
    for (const agentType of AETHER_AGENT_TYPES) {
      for (const model of AETHER_PLATFORM_CATALOG.agents[agentType].models) {
        const efforts = reasoningEffortsForModel(agentType, model.slug);
        const defaultEffort = defaultReasoningEffortForModel(agentType, model.slug);
        if (efforts.length === 0) {
          expect(defaultEffort).toBeUndefined();
        } else {
          expect(defaultEffort).toBeDefined();
          expect(efforts).toContain(defaultEffort);
        }
      }
    }
  });

  it("offers no reasoning efforts for claude-haiku-4-5 (in no effort group)", () => {
    expect(reasoningEffortsForModel("claude-code", "claude-haiku-4-5")).toEqual([]);
    expect(defaultReasoningEffortForModel("claude-code", "claude-haiku-4-5")).toBeUndefined();
  });

  it("restricts gpt-5.6-luna to its narrower effort group", () => {
    expect(reasoningEffortsForModel("codex", "gpt-5.6-luna")).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });
});
