import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES } from "@t3tools/contracts";

import {
  buildClaudeCodexModelPreferencesPrompt,
  buildManagedClaudeCodexRoutingPrompt,
  effectiveClaudeCodexModel,
  resolveClaudeCodexRoutingPrompt,
} from "./claudeCodexRouting.ts";

describe("Claude Codex routing prompt", () => {
  it("renders the effective model into the managed Haiku-slot instructions", () => {
    const prompt = buildManagedClaudeCodexRoutingPrompt("gpt-5.5");
    expect(prompt).toContain("haiku");
    expect(prompt).toContain("gpt-5.5");
    expect(prompt).toContain("do not run Anthropic Haiku");
    expect(prompt).toContain("Exploration and research → Codex subagent");
    expect(prompt).toContain("Planning and architecture → Claude subagent");
    expect(prompt).toContain('Agent(model: "opus")');
    expect(prompt).toContain("acts as a thin orchestrator");
    expect(prompt).toContain("Do not keep planning, design, implementation, review");
  });

  it("uses the verified default for blank model selections", () => {
    expect(effectiveClaudeCodexModel("  ")).toBe("gpt-5.6-sol");
  });

  it("renders each structured task preference and the selected second-opinion policy", () => {
    const prompt = buildClaudeCodexModelPreferencesPrompt("gpt-5.5", {
      ...DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      claudeSubagentModel: "fable",
      claudeSubagentModels: {
        exploration: "sonnet",
        implementation: "opus",
        review: "sonnet",
      },
      exploration: "claude",
      implementation: "adaptive",
      secondOpinion: "reviews",
    });
    expect(prompt).toContain("Exploration and research → Claude subagent");
    expect(prompt).toContain(
      "Exploration and research → Claude subagent: Delegate codebase mapping",
    );
    expect(prompt).toContain('Agent(model: "sonnet")');
    expect(prompt).toContain("Implementation and refactors → best-fit subagent");
    expect(prompt).toContain('use `Agent(model: "opus")` for interactive');
    expect(prompt).toContain("consequential reviews of real changes");
    expect(prompt).not.toContain("consequential plans and architecture decisions");
    expect(prompt).toContain("run both blind opinions in parallel");
    expect(prompt).toContain('run the Claude opinion through `Agent(model: "sonnet")`');
  });

  it("uses the matching category model for plan and review second opinions", () => {
    const prompt = buildClaudeCodexModelPreferencesPrompt("gpt-5.5", {
      ...DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      claudeSubagentModels: { planning: "opus", review: "sonnet" },
    });
    expect(prompt).toContain(
      'plans and architecture decisions, run the Claude opinion through `Agent(model: "opus")`',
    );
    expect(prompt).toContain('reviews of real changes, use `Agent(model: "sonnet")`');
  });

  it("keeps the non-editable bridge fact ahead of a custom policy and user additions", () => {
    const prompt = resolveClaudeCodexRoutingPrompt({
      enabled: true,
      model: "gpt-5.5",
      modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      promptMode: "custom",
      customPrompt: "Custom routing.",
      additionalInstructions: "Team conventions.",
    });
    expect(prompt).toContain("The Claude `haiku` subagent slot is remapped");
    expect(prompt).toContain("Custom routing.\n\nTeam conventions.");
    expect(prompt?.indexOf("Claude Code → Codex bridge")).toBeLessThan(
      prompt?.indexOf("Custom routing.") ?? -1,
    );
  });

  it("can omit preference guidance without hiding the bridge mechanics", () => {
    const prompt = resolveClaudeCodexRoutingPrompt({
      enabled: true,
      model: "gpt-5.5",
      modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
      promptMode: "none",
      customPrompt: "",
      additionalInstructions: "",
    });
    expect(prompt).toContain("Claude Code → Codex bridge");
    expect(prompt).not.toContain("Model preferences");
  });

  it("uses a truthful all-Codex prompt when the routed model is selected as the main model", () => {
    const prompt = resolveClaudeCodexRoutingPrompt(
      {
        enabled: true,
        model: "gpt-5.5",
        modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
        promptMode: "managed",
        customPrompt: "",
        additionalInstructions: "Team conventions.",
      },
      "gpt-5.5",
      "gpt-5.5",
    );
    expect(prompt).toContain("Codex main session through Claude Code");
    expect(prompt).toContain("It is not running an Anthropic model");
    expect(prompt).not.toContain("Subagent routing");
    expect(prompt).toContain("implementation, planning, design, review, verification");
    expect(prompt).toContain("Team conventions.");
  });

  it("sends no routing prompt when the slot is disabled", () => {
    expect(
      resolveClaudeCodexRoutingPrompt({
        enabled: false,
        model: "",
        modelPreferences: DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
        promptMode: "managed",
        customPrompt: "",
        additionalInstructions: "",
      }),
    ).toBeUndefined();
  });
});
