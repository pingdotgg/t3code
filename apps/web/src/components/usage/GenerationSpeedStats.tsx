import { useMemo } from "react";
import { type UsageProviderKind, type UsageSummary } from "@t3tools/contracts";
import {
  GENERATION_SPEED_DESCRIPTION,
  formatGenerationSpeed,
  generationModelLabel,
  generationTrackingLabel,
  mergeGenerationSpeedHistory,
} from "@t3tools/client-runtime/generation-speed";
import { formatDayShort, formatHourShort } from "@t3tools/shared/usageFormat";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function GenerationSpeedStats({
  environments,
  hiddenProviders,
  timeZone,
}: {
  readonly environments: readonly { label: string; summary: UsageSummary | null }[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly timeZone: string;
}) {
  const speed = useMemo(
    () => mergeGenerationSpeedHistory(environments, hiddenProviders),
    [environments, hiddenProviders],
  );
  if (speed.tracking.length === 0) return null;
  return (
    <section className="mt-8 space-y-4" aria-label="Generation speed">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Generation speed</h2>
        {speed.totals.responses > 0 ? (
          <p className="text-lg tabular-nums">{formatGenerationSpeed(speed.totals)}</p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{GENERATION_SPEED_DESCRIPTION}</p>
      <div className="text-xs text-muted-foreground">
        {speed.tracking.map((tracking) => (
          <p key={`${tracking.label}:${tracking.startedAt}`}>
            {environments.length > 1 ? `${tracking.label}: ` : ""}
            {generationTrackingLabel(tracking.startedAt)}
          </p>
        ))}
      </div>
      {speed.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No generation measurements in this period. New Codex and Claude responses are tracked as
          they complete.
        </p>
      ) : (
        <>
          <div className="divide-y divide-border/50">
            {speed.models.map((model) => (
              <div
                key={JSON.stringify([
                  model.provider,
                  model.model,
                  model.reasoningEffort,
                  model.serviceTier,
                ])}
                className="flex items-center justify-between gap-4 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate">{generationModelLabel(model)}</p>
                  <p className="text-xs text-muted-foreground">
                    {PROVIDER_PRESENTATION[model.provider].label}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums">{formatGenerationSpeed(model)}</span>
              </div>
            ))}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Generation speed history
            </summary>
            <div className="mt-3 divide-y divide-border/50">
              {speed.periods.map((period) => (
                <div
                  key={period.hourStart ?? period.day}
                  className="flex justify-between gap-4 py-2 tabular-nums"
                >
                  <span>
                    {period.hourStart
                      ? formatHourShort(period.hourStart, timeZone)
                      : formatDayShort(period.day)}
                  </span>
                  <span>{formatGenerationSpeed(period)}</span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
