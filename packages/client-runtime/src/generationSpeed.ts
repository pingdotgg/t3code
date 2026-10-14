import {
  USAGE_CONTRACT_VERSION,
  type GenerationSpeed,
  type GenerationSpeedBucket,
  type GenerationSpeedHistory,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import { isCompatibleUsageContractVersion } from "@t3tools/shared/usageMerge";

export function generationTokensPerSecond(
  speed: Pick<GenerationSpeed, "outputTokens" | "durationMs">,
): number | null {
  return speed.durationMs > 0 && speed.outputTokens > 0
    ? (speed.outputTokens * 1_000) / speed.durationMs
    : null;
}

export function formatGenerationSpeed(
  speed: Pick<GenerationSpeed, "outputTokens" | "durationMs">,
): string {
  const rate = generationTokensPerSecond(speed);
  return rate === null
    ? "—"
    : `~${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })} tok/s`;
}

export const GENERATION_SPEED_DESCRIPTION =
  "Estimated output tokens per second during model generation, including reasoning and tool arguments. Tool execution, approvals, and the wait before generation starts are excluded.";

/** A run can span several provider turns, such as a Codex goal or a recovery. */
export function runGenerationSpeedLabel(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts"> | undefined,
  runId: RunId | null | undefined,
): string | null {
  if (projection === undefined || runId == null) return null;
  const attempts = new Set(
    projection.attempts.filter((attempt) => attempt.runId === runId).map((attempt) => attempt.id),
  );
  let outputTokens = 0;
  let durationMs = 0;
  for (const turn of projection.providerTurns) {
    if (
      turn.runAttemptId === null ||
      !attempts.has(turn.runAttemptId) ||
      turn.generationSpeed === undefined
    )
      continue;
    outputTokens += turn.generationSpeed.outputTokens;
    durationMs += turn.generationSpeed.durationMs;
  }
  return durationMs > 0 && outputTokens > 0
    ? formatGenerationSpeed({ outputTokens, durationMs })
    : null;
}

type SpeedModel = {
  -readonly [K in keyof Omit<GenerationSpeedBucket, "day" | "hourStart" | "startedAt">]: Omit<
    GenerationSpeedBucket,
    "day" | "hourStart" | "startedAt"
  >[K];
};
type SpeedPeriod = {
  day: string;
  hourStart?: string;
  outputTokens: number;
  durationMs: number;
  responses: number;
};

/** Merges only generation samples; unrelated historical token totals never enter the rate. */
export function mergeGenerationSpeedHistory(
  environments: readonly { label: string; summary: UsageSummary | null }[],
  hiddenProviders: ReadonlySet<UsageProviderKind> = new Set(),
) {
  const seen = new Set<GenerationSpeedHistory["sourceId"]>();
  const tracking: { label: string; startedAt: string }[] = [];
  const models = new Map<string, SpeedModel>();
  const periods = new Map<string, SpeedPeriod>();
  const totals = { outputTokens: 0, durationMs: 0, responses: 0 };
  for (const environment of environments) {
    if (
      environment.summary === null ||
      !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
    )
      continue;
    const history = environment.summary.generationSpeed;
    if (history === undefined || seen.has(history.sourceId)) continue;
    seen.add(history.sourceId);
    tracking.push({ label: environment.label, startedAt: history.trackingStartedAt });
    for (const bucket of history.buckets) {
      if (
        hiddenProviders.has(bucket.provider) ||
        bucket.durationMs <= 0 ||
        bucket.outputTokens <= 0
      )
        continue;
      const modelKey = JSON.stringify([
        bucket.provider,
        bucket.model,
        bucket.reasoningEffort,
        bucket.serviceTier,
      ]);
      const model = models.get(modelKey) ?? {
        ...bucket,
        outputTokens: 0,
        durationMs: 0,
        responses: 0,
      };
      const periodKey = bucket.hourStart ?? bucket.day;
      const period = periods.get(periodKey) ?? {
        day: bucket.day,
        ...(bucket.hourStart === undefined ? {} : { hourStart: bucket.hourStart }),
        outputTokens: 0,
        durationMs: 0,
        responses: 0,
      };
      for (const total of [model, period, totals]) {
        total.outputTokens += bucket.outputTokens;
        total.durationMs += bucket.durationMs;
        total.responses += bucket.responses;
      }
      models.set(modelKey, model);
      periods.set(periodKey, period);
    }
  }
  return {
    tracking,
    totals,
    models: [...models.values()].sort(
      (a, b) => (generationTokensPerSecond(b) ?? 0) - (generationTokensPerSecond(a) ?? 0),
    ),
    periods: [...periods.values()].sort((a, b) =>
      (b.hourStart ?? b.day).localeCompare(a.hourStart ?? a.day),
    ),
  };
}

export function generationModelLabel(
  model: Pick<SpeedModel, "model" | "reasoningEffort" | "serviceTier">,
): string {
  return [model.model, model.reasoningEffort, model.serviceTier].filter(Boolean).join(" · ");
}

export function generationTrackingLabel(at: string): string {
  // @effect-diagnostics-next-line globalDate:off -- formats a server-supplied timestamp for the client locale.
  return `Tracking since ${new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}
