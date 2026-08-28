import type { UsageLimitWindow, UsageLimitsProviderKind } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDateTimeShort } from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import {
  useUsageLimits,
  type EnvironmentUsageLimitsStatus,
  type ProviderLimitsStatus,
} from "../../state/usage";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Display order; providers not yet reporting render as placeholders. */
const LIMITS_PROVIDER_ORDER: readonly UsageLimitsProviderKind[] = [
  "claude",
  "codex",
  "grok",
  "opencode",
];

/**
 * The "Limits" half of the usage page: how much of each subscription rate
 * window is consumed, one card per provider.
 *
 */
export function UsageLimitsContent() {
  const { providers, environments, isPending, isPartial, refresh } = useUsageLimits();

  // Same settling rule as the usage view: hold until every environment is
  // terminal so cards do not pop in one at a time.
  const settling = isPending || isPartial;

  // Reset countdowns must keep moving while the page sits open; a frozen
  // "in 4m" that is long past is worse than no countdown at all.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const answered = environments.some((environment) => environment.summary !== null);
  const ordered = LIMITS_PROVIDER_ORDER.flatMap((provider) =>
    providers.filter((candidate) => candidate.provider === provider),
  );
  const unreported = LIMITS_PROVIDER_ORDER.filter(
    (provider) => !providers.some((candidate) => candidate.provider === provider),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          How much of each plan's rate windows is used right now.
        </p>
        <Button onClick={refresh} aria-label="Refresh limits" size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {settling ? (
        <UsageLimitsSkeleton />
      ) : !answered ? (
        // Without a single answer, "coming soon" cards would misread as "no
        // provider supports this"; say what actually happened instead.
        <>
          <UsageLimitsCoverageNotice environments={environments} />
          <p className="py-6 text-center text-sm text-muted-foreground">
            No connected environment reported limits.
          </p>
        </>
      ) : (
        <>
          <UsageLimitsCoverageNotice environments={environments} />
          <section className="grid gap-4 lg:grid-cols-2">
            {ordered.map((entry) => (
              <ProviderLimitsCard
                key={`${entry.provider}:${entry.limits.email ?? entry.environmentLabels.join(",")}`}
                entry={entry}
                nowMs={nowMs}
                multiEnvironment={environments.length > 1}
              />
            ))}
            {unreported.map((provider) => (
              <UpcomingProviderCard key={provider} provider={provider} />
            ))}
          </section>
        </>
      )}
    </>
  );
}

function ProviderLimitsCard({
  entry,
  nowMs,
  multiEnvironment,
}: {
  readonly entry: ProviderLimitsStatus;
  readonly nowMs: number;
  readonly multiEnvironment: boolean;
}) {
  const { provider, limits } = entry;
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return (
    <div className="flex flex-col gap-5 rounded-md border border-border p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Mark className="size-4 shrink-0" aria-hidden />
          {PROVIDER_PRESENTATION[provider].label}
        </span>
        {limits.plan !== null ? (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            {limits.plan}
          </span>
        ) : null}
      </div>

      {limits.availability === "available" ? (
        <div className="flex flex-col gap-4">
          {limits.windows.map((window) => (
            <LimitWindowRow key={window.id} provider={provider} window={window} nowMs={nowMs} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {limits.message ?? "This provider did not report limits."}
        </p>
      )}

      {limits.email !== null || multiEnvironment ? (
        <span className="truncate text-xs text-muted-foreground">
          {[
            limits.email,
            multiEnvironment ? `Reported by ${entry.environmentLabels.join(", ")}` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function LimitWindowRow({
  provider,
  window,
  nowMs,
}: {
  readonly provider: UsageLimitsProviderKind;
  readonly window: UsageLimitWindow;
  readonly nowMs: number;
}) {
  const resetsIn = window.resetsAt === null ? null : formatResetsIn(window.resetsAt, nowMs);
  const caption = [window.detail, resetsIn === null ? null : `Resets ${resetsIn}`]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-foreground">{window.label}</span>
        <span
          className={cn(
            "text-sm tabular-nums",
            window.utilization >= 90
              ? "text-destructive"
              : window.utilization >= 75
                ? "text-warning"
                : "text-foreground",
          )}
        >
          {Math.round(window.utilization)}% used
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(window.utilization, 100).toFixed(1)}%`,
            backgroundColor: utilizationColor(provider, window.utilization),
          }}
        />
      </div>
      {caption.length > 0 ? (
        window.resetsAt === null ? (
          <span className="text-xs text-muted-foreground">{caption}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<span className="self-start text-xs text-muted-foreground">{caption}</span>}
            />
            <TooltipPopup side="bottom">{formatDateTimeShort(window.resetsAt)}</TooltipPopup>
          </Tooltip>
        )
      ) : null}
    </div>
  );
}

/** Provider brand color until the window runs hot, then the alert tokens. */
function utilizationColor(provider: UsageLimitsProviderKind, utilization: number): string {
  if (utilization >= 90) return "var(--color-destructive)";
  if (utilization >= 75) return "var(--color-warning)";
  return PROVIDER_PRESENTATION[provider].color;
}

/** "in 3h 12m" / "in 2d 4h" / "in under a minute". */
function formatResetsIn(resetsAt: string, nowMs: number): string | null {
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  // A reset instant in the past means the figures themselves are stale;
  // dropping the countdown beats counting up from a moment that already
  // happened.
  if (resetMs <= nowMs) return null;
  const remainingMinutes = Math.floor((resetMs - nowMs) / 60_000);
  if (remainingMinutes < 1) return "in under a minute";
  const days = Math.floor(remainingMinutes / (60 * 24));
  const hours = Math.floor((remainingMinutes % (60 * 24)) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

function UpcomingProviderCard({ provider }: { readonly provider: UsageLimitsProviderKind }) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-5">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Mark className="size-4 shrink-0" aria-hidden />
        {PROVIDER_PRESENTATION[provider].label}
      </span>
      <p className="text-sm text-muted-foreground">
        Limit tracking for {PROVIDER_PRESENTATION[provider].label} is not wired up yet.
      </p>
    </div>
  );
}

/** Environments that could not answer, in the usage view's notice style. */
function UsageLimitsCoverageNotice({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  if (failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.environmentId}>
          {environment.label} could not report limits. It may run an older server version.
        </span>
      ))}
    </div>
  );
}

/** Deterministic widths, mirroring the loaded cards' shape. */
const SKELETON_BAR_WIDTHS = [62, 34, 81];

function UsageLimitsSkeleton() {
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      {LIMITS_PROVIDER_ORDER.map((provider) => {
        const Mark = PROVIDER_PRESENTATION[provider].mark;
        return (
          <div key={provider} className="flex flex-col gap-5 rounded-md border border-border p-5">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Mark className="size-4 shrink-0" aria-hidden />
              {PROVIDER_PRESENTATION[provider].label}
            </span>
            <div className="flex flex-col gap-4">
              {SKELETON_BAR_WIDTHS.map((width) => (
                <div key={width} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="h-3.5 w-28 rounded-sm bg-muted" />
                    <div className="h-3.5 w-14 rounded-sm bg-muted" />
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-border" style={{ width: `${width}%` }} />
                  </div>
                  <div className="h-3 w-40 rounded-sm bg-muted" />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
