import { matchingSkillRuleForCell } from "@t3tools/client-runtime/state/skills";
import type {
  ExecutionEnvironmentCapabilities,
  SkillModelCell,
  SkillVariantRule,
  SkillVerdict,
} from "@t3tools/contracts";

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const RATE_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const DURATION_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function hasSkillsCapability(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.skills === true;
}

export function skillVerdictLabel(verdict: SkillVerdict): string {
  switch (verdict.verdict) {
    case "helps":
      return "Helps";
    case "hurts":
      return "Hurts";
    case "not-enough-data":
      return "Not enough data";
  }
}

export function skillVerdictReason(verdict: SkillVerdict): string | null {
  if (verdict.verdict !== "not-enough-data") return null;
  switch (verdict.reason) {
    case "too-few-tasks":
      return `Too few tasks (${verdict.nTasks}/50)`;
    case "too-few-repeats":
      return "Too few repeats or judge samples: needs 3 each";
    case "wide-interval":
      return "The confidence interval is too wide";
    case "likely-negligible":
      return "The measured effect is likely negligible";
    case "no-evaluations":
    case null:
      return "No completed evaluations";
  }
}

export function formatSkillEffect(value: number | null): string {
  return value === null ? "unknown" : PERCENT_FORMAT.format(value);
}

export function formatSkillRate(value: number | null): string {
  return value === null ? "unknown" : RATE_FORMAT.format(value);
}

export function formatSkillInterval(low: number | null, high: number | null): string {
  return low === null || high === null
    ? "unknown"
    : `${PERCENT_FORMAT.format(low)} to ${PERCENT_FORMAT.format(high)}`;
}

export function skillCellEvidenceSummary(cell: SkillModelCell): string {
  return `${cell.driver} · ${cell.model} · ${skillVerdictLabel(cell.verdict)} · ${formatSkillEffect(cell.verdict.effect)} effect · 95% CI ${formatSkillInterval(cell.verdict.ciLow, cell.verdict.ciHigh)} · n=${cell.verdict.nTasks}`;
}

export function skillDeliveryLabel(cell: SkillModelCell): string {
  switch (cell.delivery) {
    case "developer-context":
      return "Developer context";
    case "turn-prompt":
      return "Turn prompt";
    case "system-prompt":
      return "System prompt";
    case "unsupported":
      return "Not delivered";
  }
}

export function skillGatingLabel(cell: SkillModelCell): string {
  switch (cell.gating) {
    case "native":
      return "Hard gate";
    case "instruction":
      return "Instruction (best effort)";
    case "none":
      return "Not delivered";
  }
}

export function skillGatingDescription(cell: SkillModelCell): string {
  switch (cell.gating) {
    case "native":
      return "The provider harness blocks this skill.";
    case "instruction":
      return "The model is asked not to use this skill.";
    case "none":
      return "This skill is not delivered to the model.";
  }
}

export function skillEffectiveModeLabel(cell: SkillModelCell): string {
  switch (cell.effectiveMode) {
    case "base":
      return "Base skill";
    case "variant":
      return "Model variant";
    case "off":
      return "Off";
  }
}

export function skillObservationalSummary(cell: SkillModelCell): string {
  const observation = cell.observational;
  return [
    `${COUNT_FORMAT.format(observation.turns)} turns`,
    `${formatSkillRate(observation.activationRate)} activation`,
    `${formatSkillRate(observation.completionRate)} completion`,
    `${formatSkillRate(observation.revertRate)} reverted`,
    `${formatSkillRate(observation.toolFailureRate)} tool failures`,
    observation.medianTokens === null
      ? "unknown median tokens"
      : `${COUNT_FORMAT.format(observation.medianTokens)} median tokens`,
    observation.medianDurationMs === null
      ? "unknown median duration"
      : `${DURATION_FORMAT.format(observation.medianDurationMs / 1_000)} s median duration`,
  ].join(" · ");
}

function matchesCellTarget(rule: SkillVariantRule, cell: SkillModelCell): boolean {
  return rule.driver === cell.driver && rule.model?.toLowerCase() === cell.model.toLowerCase();
}

export const ruleForSkillCell = matchingSkillRuleForCell;

export function turnBackOnRuleForSkillCell(
  cell: SkillModelCell,
  rules: readonly SkillVariantRule[],
): SkillVariantRule | null {
  if (cell.effectiveMode !== "off") return null;
  return (
    rules.find(
      (rule) =>
        rule.ruleId === cell.ruleId &&
        rule.deletedAt === null &&
        rule.enabled &&
        rule.mode === "off" &&
        matchesCellTarget(rule, cell),
    ) ?? null
  );
}

export function skillRuleTargetLabel(rule: SkillVariantRule): string {
  if (rule.driver === null) return "All providers";
  return rule.model === null ? rule.driver : `${rule.driver} · ${rule.model}`;
}
