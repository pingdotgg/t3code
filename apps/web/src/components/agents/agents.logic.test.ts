import { describe, expect, it } from "vite-plus/test";
import type { McpGatewayProfile } from "@t3tools/contracts";
import {
  agentAccentColor,
  agentColors,
  agentHasAdvancedSettings,
  defaultAgentColor,
  soleOption,
} from "./agents.logic";

const base: McpGatewayProfile = {
  profileId: "b",
  name: "Builder",
  revision: 1,
  color: agentColors[1]!,
  providerLabel: "Codex",
  modelLabel: "gpt-5.4",
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};
const profiles = [{ profileId: "a" }, base];

describe("agent editor defaults", () => {
  it("keeps Advanced closed for an agent with only basic fields and its palette color", () => {
    expect(agentHasAdvancedSettings(base, profiles)).toBe(false);
    expect(agentHasAdvancedSettings({ ...base, tags: ["Dev"], iconId: "rocket" }, profiles)).toBe(
      false,
    );
  });

  it.each<[string, Partial<McpGatewayProfile>]>([
    ["description", { description: "Reviews code" }],
    ["system prompt", { systemPrompt: "Be terse" }],
    ["skills", { skillIds: ["s1"] }],
    ["user skills off", { includeUserSkills: false }],
    ["reasoning effort", { reasoningEffort: "high" }],
    ["machines", { environmentIds: ["mac"] }],
    ["permission mode", { runtimeMode: "full-access" }],
    ["interaction mode", { interactionMode: "plan" }],
    ["custom color", { color: "#123456" }],
  ])("opens Advanced when %s is set", (_, change) => {
    expect(agentHasAdvancedSettings({ ...base, ...change }, profiles)).toBe(true);
  });

  it("gives a new agent the next palette slot", () => {
    expect(defaultAgentColor(null, profiles)).toBe(agentColors[2]);
    expect(defaultAgentColor(base, profiles)).toBe(agentColors[1]);
  });

  it("preselects only a sole option", () => {
    expect(soleOption(["Codex"])).toBe("Codex");
    expect(soleOption(["Codex", "Claude"])).toBeUndefined();
    expect(soleOption([])).toBeUndefined();
  });

  it("colors a run by its agent's palette slot, like the board, and mutes removed agents", () => {
    const uncolored = { ...base, color: undefined };
    expect(agentAccentColor(uncolored, [{ ...base, profileId: "a" }, uncolored])).toBe(
      agentColors[1],
    );
    expect(agentAccentColor(undefined, [base])).toBe("var(--muted-foreground)");
  });
});
