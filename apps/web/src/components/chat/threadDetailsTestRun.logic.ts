import { QA_VERDICTS, type QaRun, type QaVerdict } from "@t3tools/contracts";

export const VERDICT_BADGE_VARIANT = {
  PASS: "success",
  FAIL: "error",
  BLOCKED: "warning",
  INCONCLUSIVE: "secondary",
  SKIPPED: "secondary",
} as const satisfies Record<QaVerdict, string>;

/** Non-zero verdict counts, in severity-neutral report order. */
export function verdictSummary(run: Pick<QaRun, "scenarios">) {
  return QA_VERDICTS.map((verdict) => ({
    verdict,
    count: run.scenarios.filter((scenario) => scenario.verdict === verdict).length,
  })).filter((entry) => entry.count > 0);
}

export function formatVideoOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function runStartedLabel(run: Pick<QaRun, "startedAt">): string {
  const started = new Date(run.startedAt);
  return Number.isNaN(started.getTime())
    ? run.startedAt
    : started.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
