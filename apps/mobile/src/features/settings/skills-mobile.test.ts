import type { ProviderDriverKind, SkillModelCell, SkillVariantRule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasSkillsCapability,
  ruleForSkillCell,
  skillCellEvidenceSummary,
  skillGatingDescription,
  skillGatingLabel,
  skillVerdictReason,
  turnBackOnRuleForSkillCell,
} from "./skills-mobile";

const CLAUDE_DRIVER = "claude" as ProviderDriverKind;

const cell = {
  driver: CLAUDE_DRIVER,
  model: "claude-fable-5-1",
  delivery: "turn-prompt",
  gating: "native",
  effectiveMode: "off",
  ruleId: "global-off",
  verdict: {
    verdict: "not-enough-data",
    reason: "too-few-tasks",
    effect: null,
    ciLow: null,
    ciHigh: null,
    pAdjusted: null,
    nTasks: 4,
  },
  observational: {
    turns: 3,
    activationRate: null,
    completionRate: null,
    completionCiLow: null,
    completionCiHigh: null,
    revertRate: null,
    revertCiLow: null,
    revertCiHigh: null,
    toolFailureRate: null,
    medianTokens: null,
    medianDurationMs: null,
    confounded: true,
  },
} satisfies SkillModelCell;

function rule(overrides: Partial<SkillVariantRule>): SkillVariantRule {
  return {
    ruleId: "global-off",
    skillName: "review",
    driver: null,
    model: null,
    mode: "off",
    body: null,
    enabled: true,
    forkedFromRuleId: null,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("mobile skill presentation", () => {
  it("treats an old server without the Skills capability as unsupported", () => {
    expect(hasSkillsCapability({ repositoryIdentity: true })).toBe(false);
    expect(hasSkillsCapability({ repositoryIdentity: true, skills: true })).toBe(true);
  });

  it("does not offer turn back on for an inherited off rule", () => {
    const inherited = rule({});
    expect(ruleForSkillCell(cell, [inherited])).toBe(inherited);
    expect(turnBackOnRuleForSkillCell(cell, [inherited])).toBeNull();
  });

  it("reverses an exact model off rule", () => {
    const exact = rule({
      ruleId: "model-off",
      driver: CLAUDE_DRIVER,
      model: "CLAUDE-FABLE-5-1",
    });
    const exactCell = { ...cell, ruleId: exact.ruleId };
    expect(ruleForSkillCell(exactCell, [exact])).toBe(exact);
    expect(turnBackOnRuleForSkillCell(exactCell, [exact])).toBe(exact);
  });

  it("surfaces a disabled provider variant ahead of a broader effective rule", () => {
    const global = rule({});
    const disabledProviderVariant = rule({
      ruleId: "provider-variant",
      driver: CLAUDE_DRIVER,
      mode: "variant",
      body: "Provider variant",
      enabled: false,
    });
    expect(ruleForSkillCell(cell, [global, disabledProviderVariant])).toBe(disabledProviderVariant);
  });

  it("explains native and instruction gating distinctly", () => {
    expect(skillGatingLabel(cell)).toBe("Hard gate");
    expect(skillGatingDescription(cell)).toBe("The provider harness blocks this skill.");
    const instructionCell = { ...cell, gating: "instruction" as const };
    expect(skillGatingLabel(instructionCell)).toBe("Instruction (best effort)");
    expect(skillGatingDescription(instructionCell)).toBe(
      "The model is asked not to use this skill.",
    );
  });

  it("explains the repeat and judge-sample evidence floor", () => {
    expect(skillVerdictReason({ ...cell.verdict, reason: "too-few-repeats" })).toBe(
      "Too few repeats or judge samples: needs 3 each",
    );
  });

  it("labels missing controlled estimates as unknown instead of zero", () => {
    expect(skillCellEvidenceSummary(cell)).toBe(
      "claude · claude-fable-5-1 · Not enough data · unknown effect · 95% CI unknown · n=4",
    );
  });
});
