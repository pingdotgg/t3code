import type {
  ModelSelection,
  ProjectId,
  ServerSettings,
  SkillEvalArmResult,
  SkillEvalRunConfig,
  SkillEvalRunSummary,
  SkillModelCell,
  SkillVerdict,
} from "@t3tools/contracts";

import {
  applyProviderInstanceSettings,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "../../../providerInstances";

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const UNSIGNED_PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});
const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const INTEGER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const USD_FORMAT = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export function formatEffect(value: number | null): string {
  return value === null ? "unknown" : PERCENT_FORMAT.format(value);
}

export function formatRate(value: number | null): string {
  return value === null ? "unknown" : UNSIGNED_PERCENT_FORMAT.format(value);
}

export function formatInterval(low: number | null, high: number | null): string {
  return low === null || high === null
    ? "unknown"
    : `${PERCENT_FORMAT.format(low)} to ${PERCENT_FORMAT.format(high)}`;
}

export function formatPValue(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 0.001) return "<0.001";
  return value < 0.01 ? value.toFixed(3) : NUMBER_FORMAT.format(value);
}

export function formatCount(value: number | null): string {
  return value === null ? "unknown" : INTEGER_FORMAT.format(value);
}

export function formatDuration(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1_000) return `${INTEGER_FORMAT.format(value)} ms`;
  if (value < 60_000) return `${NUMBER_FORMAT.format(value / 1_000)} s`;
  return `${NUMBER_FORMAT.format(value / 60_000)} min`;
}

export function formatCost(value: number | null): string {
  if (value === null) return "unknown";
  // A paired difference below the displayed precision must not read as "-$0.00".
  return USD_FORMAT.format(Math.abs(value) < 0.00005 ? 0 : value);
}

export function deliveryLabel(cell: Pick<SkillModelCell, "delivery">): string {
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

export function gatingLabel(cell: Pick<SkillModelCell, "gating">): string {
  switch (cell.gating) {
    case "native":
      return "Hard gate";
    case "instruction":
      return "Instruction (best effort)";
    case "none":
      return "Not delivered";
  }
}

export function effectiveModeLabel(cell: Pick<SkillModelCell, "effectiveMode">): string {
  switch (cell.effectiveMode) {
    case "base":
      return "Base skill";
    case "variant":
      return "Model variant";
    case "off":
      return "Off";
  }
}

export function verdictLabel(verdict: Pick<SkillVerdict, "verdict">): string {
  switch (verdict.verdict) {
    case "helps":
      return "Helps";
    case "hurts":
      return "Hurts";
    case "not-enough-data":
      return "Not enough data";
  }
}

export function verdictReason(verdict: SkillVerdict): string | null {
  if (verdict.verdict !== "not-enough-data") return null;
  switch (verdict.reason) {
    case "too-few-tasks":
      return `Too few tasks: ${verdict.nTasks}/50`;
    case "too-few-repeats":
      return "Too few repeats or judge samples: needs 3 each";
    case "wide-interval":
      return "Interval too wide";
    case "likely-negligible":
      return "Likely negligible";
    case "no-evaluations":
    case null:
      return "No evaluations";
  }
}

export function evaluationCandidateForProject(
  cell: SkillModelCell,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId,
): ModelSelection | null {
  const entry = applyProviderInstanceSettings(entries, settings, projectId).find(
    (candidate) =>
      candidate.driverKind === cell.driver &&
      isProviderInstancePickerReady(candidate) &&
      candidate.models.some((model) => model.slug === cell.model),
  );
  return entry === undefined ? null : { instanceId: entry.instanceId, model: cell.model };
}

export function runTrialCount(config: SkillEvalRunConfig): number {
  return config.taskIds.length * config.arms.length * config.repeats;
}

export function runJudgeCallCount(config: SkillEvalRunConfig): number {
  const treatmentArms = config.arms.filter((arm) => arm.role === "treatment").length;
  return config.taskIds.length * config.repeats * treatmentArms * 2 * config.judgeSamples;
}

export function activeRunAction(
  run: Pick<SkillEvalRunSummary, "status">,
): "cancel" | "resume" | null {
  if (run.status === "queued" || run.status === "running" || run.status === "judging") {
    return "cancel";
  }
  if (run.status === "cancelled" || run.status === "interrupted") return "resume";
  return null;
}

export function armEvidenceSummary(result: SkillEvalArmResult): string {
  return `${formatEffect(result.effect)} effect · 95% CI ${formatInterval(result.ciLow, result.ciHigh)} · Holm-adjusted p ${formatPValue(result.pAdjusted)}`;
}
