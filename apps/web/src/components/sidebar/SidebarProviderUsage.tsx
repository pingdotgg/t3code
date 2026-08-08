import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import {
  providerPlanLabel,
  providerQuotaMeters,
  type ProviderQuotaTone,
} from "../settings/providerQuotaPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const CLOCK_INTERVAL_MS = 60_000;

const BAR_TONE: Readonly<Record<ProviderQuotaTone, string>> = {
  normal: "bg-sidebar-foreground/55",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

function hasProviderUsage(provider: ServerProvider): boolean {
  const rateLimits = provider.auth.rateLimits;
  return (
    (provider.driver === "codex" || provider.driver === "claudeAgent") &&
    provider.enabled &&
    ((rateLimits?.windows?.length ?? 0) > 0 ||
      rateLimits?.extraUsage?.isEnabled === true ||
      rateLimits?.primary !== undefined ||
      rateLimits?.secondary !== undefined ||
      (provider.auth.status === "authenticated" && !!provider.auth.planType))
  );
}

function providerTitle(provider: ServerProvider): string {
  return provider.driver === "codex" ? "Codex" : "Claude";
}

function providerUsageRank(provider: ServerProvider): number {
  return provider.driver === "codex" ? 0 : 1;
}

function extraUsageDetail(provider: ServerProvider): string | undefined {
  const extra = provider.auth.rateLimits?.extraUsage;
  if (!extra?.isEnabled) return undefined;
  const { usedCredits, monthlyLimit, currency } = extra;
  if (usedCredits === undefined && monthlyLimit === undefined) return undefined;
  const suffix = currency ? ` ${currency}` : " credits";
  return `${usedCredits ?? "—"} / ${monthlyLimit ?? "—"}${suffix}`;
}

const ProviderUsageSection = memo(function ProviderUsageSection({
  provider,
  now,
  refreshing,
  onRefresh,
  showInstanceName,
  environmentLabel,
}: {
  readonly provider: ServerProvider;
  readonly now: number;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly showInstanceName: boolean;
  readonly environmentLabel?: string;
}) {
  const meters = providerQuotaMeters(provider.auth, now);
  const plan = providerPlanLabel(provider.auth) ?? "Usage";
  const context = environmentLabel ? `${plan} · ${environmentLabel}` : plan;
  const extraDetail = extraUsageDetail(provider);
  const defaultTitle = providerTitle(provider);
  const title = showInstanceName ? (provider.displayName ?? defaultTitle) : defaultTitle;

  return (
    <section className="flex min-w-0 flex-col gap-2 px-1 py-1" aria-label={`${title} usage`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <strong className="truncate text-[11px] font-semibold text-sidebar-foreground/80">
            {title}
          </strong>
          <span className="truncate text-[9px] text-sidebar-foreground/45">{context}</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Refresh ${title} usage`}
                className="grid size-5 shrink-0 place-items-center rounded-md text-sidebar-foreground/45 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
                disabled={refreshing}
                onClick={onRefresh}
              >
                <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
              </button>
            }
          />
          <TooltipPopup side="top">Refresh {title} usage</TooltipPopup>
        </Tooltip>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {meters.map((meter) => (
          <div
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5"
            key={meter.id}
          >
            <span className="truncate text-[10.5px] text-sidebar-foreground/62" title={meter.label}>
              {meter.label}
            </span>
            <span className="font-mono text-[10px] leading-4 tabular-nums text-sidebar-foreground/72">
              {Math.round(meter.usedPercent)}%
            </span>
            <div
              className="col-span-2 h-0.5 overflow-hidden rounded-full bg-sidebar-foreground/10"
              role="meter"
              aria-label={`${meter.label} used`}
              aria-valuenow={Math.round(meter.usedPercent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn("h-full rounded-full", BAR_TONE[meter.tone])}
                style={{ width: `${Math.min(100, Math.max(0, meter.usedPercent))}%` }}
              />
            </div>
            {meter.detail || (meter.id === "extra-usage" && extraDetail) ? (
              <span className="col-span-2 truncate text-[9px] leading-3 text-sidebar-foreground/40">
                {meter.detail ?? extraDetail}
              </span>
            ) : null}
          </div>
        ))}
        {provider.auth.rateLimits?.extraUsage?.isEnabled === true &&
        provider.auth.rateLimits.extraUsage.usedPercent === undefined ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5">
            <span className="truncate text-[10.5px] text-sidebar-foreground/62">Extra usage</span>
            <span className="font-mono text-[10px] leading-4 text-sidebar-foreground/72">—</span>
            <div className="col-span-2 h-0.5 rounded-full bg-sidebar-foreground/10" />
            {extraDetail ? (
              <span className="col-span-2 truncate text-[9px] leading-3 text-sidebar-foreground/40">
                {extraDetail}
              </span>
            ) : null}
          </div>
        ) : null}
        {meters.length === 0 && provider.auth.rateLimits?.extraUsage?.isEnabled !== true ? (
          <p className="text-[10px] leading-4 text-sidebar-foreground/45">
            Usage details unavailable
          </p>
        ) : null}
      </div>
    </section>
  );
});

/** Shared footer surface used by both the normal and Session Grid project panels. */
export const SidebarProviderUsage = memo(function SidebarProviderUsage() {
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const usageProviders = useMemo(() => {
    const providers = [...serverConfigs.entries()].flatMap(([environmentId, config]) =>
      config.providers.filter(hasProviderUsage).map((provider) => ({
        environmentId,
        environmentLabel: environmentLabelById.get(environmentId),
        provider,
      })),
    );
    providers.sort(
      (left, right) => providerUsageRank(left.provider) - providerUsageRank(right.provider),
    );
    return providers;
  }, [environmentLabelById, serverConfigs]);
  const environmentCount = useMemo(
    () => new Set(usageProviders.map(({ environmentId }) => environmentId)).size,
    [usageProviders],
  );
  const [now, setNow] = useState(() => Date.now());
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const usageExpanded = useUiStateStore((state) => state.providerUsageExpanded);
  const setUsageExpanded = useUiStateStore((state) => state.setProviderUsageExpanded);
  const providerSummary = useMemo(
    () => [...new Set(usageProviders.map(({ provider }) => providerTitle(provider)))].join(" · "),
    [usageProviders],
  );

  useEffect(() => {
    if (usageProviders.length === 0 || !usageExpanded) return;
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [usageExpanded, usageProviders.length]);

  const refreshUsage = useCallback(
    (environmentId: EnvironmentId, provider: ServerProvider) => {
      if (refreshingKey !== null) return;
      const key = `${environmentId}:${provider.instanceId}`;
      setRefreshingKey(key);
      void refreshProviders({
        environmentId,
        input: { instanceId: provider.instanceId },
      }).finally(() => setRefreshingKey(null));
    },
    [refreshProviders, refreshingKey],
  );

  if (usageProviders.length === 0) return null;

  return (
    <div className="mx-1 border-b border-sidebar-border pb-1">
      <button
        aria-expanded={usageExpanded}
        aria-label={`${usageExpanded ? "Collapse" : "Expand"} provider usage`}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
        onClick={() => {
          if (!usageExpanded) setNow(Date.now());
          setUsageExpanded(!usageExpanded);
        }}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", usageExpanded && "rotate-90")}
        />
        <span className="text-[10px] font-medium uppercase tracking-wide">Usage</span>
        <span className="min-w-0 flex-1 truncate text-right text-[9px] opacity-65">
          {providerSummary}
        </span>
      </button>
      {usageExpanded ? (
        <div className="max-h-[40vh] overflow-y-auto pb-1">
          {usageProviders.map(({ environmentId, environmentLabel, provider }, index) => {
            const key = `${environmentId}:${provider.instanceId}`;
            return (
              <div
                className={cn(index > 0 && "mt-1 border-t border-sidebar-border pt-1")}
                key={key}
              >
                <ProviderUsageSection
                  provider={provider}
                  now={now}
                  refreshing={refreshingKey === key}
                  onRefresh={() => refreshUsage(environmentId, provider)}
                  showInstanceName={usageProviders.length > 1}
                  {...(environmentCount > 1 && environmentLabel ? { environmentLabel } : {})}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
