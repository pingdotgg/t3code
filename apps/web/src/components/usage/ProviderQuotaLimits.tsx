"use client";

import type {
  EnvironmentId,
  ServerConfig,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";

import { cn } from "../../lib/utils";
import {
  formatDateTimeTimestamp,
  formatUtcDateTimestamp,
  parseTimestampDate,
} from "../../timestampFormat";
import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";

function usageBarColor(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-warning";
  return "bg-foreground";
}

export function formatUsageResetDate(
  resetsAt: string | undefined,
  timestampFormat: TimestampFormat = "locale",
): string | null {
  if (!resetsAt) return null;
  const date = parseTimestampDate(resetsAt);
  if (!date) return null;
  // Cursor's panel is date-only ("Resets 16 Sept"). We store that as UTC
  // midnight; including a clock would invent a local time like 5:30 AM.
  if (/T00:00:00(?:\.000)?Z$/.test(resetsAt)) {
    const formatted = formatUtcDateTimestamp(resetsAt);
    return formatted.length > 0 ? formatted : null;
  }
  const formatted = formatDateTimeTimestamp(resetsAt, timestampFormat);
  return formatted.length > 0 ? formatted : null;
}

export function sharedUsageResetAt(
  windows: ServerProviderUsageLimits["windows"],
): string | undefined {
  if (windows.length === 0) return undefined;
  const first = windows[0]?.resetsAt;
  if (!first) return undefined;
  return windows.every((window) => window.resetsAt === first) ? first : undefined;
}

export function getUsageWindowKey(window: ServerProviderUsageLimits["windows"][number]): string {
  return `${window.kind}:${window.label}:${window.windowDurationMins ?? "unknown"}:${window.resetsAt ?? "none"}`;
}

export function providerQuotaLabel(provider: ServerProvider): string {
  return (
    provider.displayName?.trim() ||
    getDriverOption(provider.driver)?.label ||
    String(provider.driver)
  );
}

export const GROK_FREE_TIER_USAGE_MESSAGE = "Usage is only shown for paid tiers";

export function isGrokFreeTier(provider: Pick<ServerProvider, "driver" | "auth">): boolean {
  if (provider.driver !== "grok") return false;
  const tier = (provider.auth.label ?? provider.auth.type ?? "").trim().toLowerCase();
  return tier === "free";
}

export function shouldShowProviderQuota(provider: ServerProvider): boolean {
  if (provider.driver === "opencode") return false;
  return provider.enabled && provider.installed && provider.availability !== "unavailable";
}

export function providerQuotaNotice(provider: ServerProvider): string | null {
  if (isGrokFreeTier(provider)) {
    return GROK_FREE_TIER_USAGE_MESSAGE;
  }
  if (!provider.usageLimits) return null;
  if (provider.usageLimits.available) return null;
  return provider.usageLimits.reason ?? "Usage data unavailable";
}

export function ProviderUsageBars(props: {
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly enabled?: boolean;
  readonly className?: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  if ((props.enabled ?? true) === false || !props.usageLimits) return null;

  const { usageLimits } = props;

  if (!usageLimits.available) {
    return (
      <p className={cn("text-xs text-muted-foreground", props.className)}>
        {usageLimits.reason ?? "Usage data unavailable"}
      </p>
    );
  }

  if (usageLimits.windows.length === 0) return null;

  const sharedReset = sharedUsageResetAt(usageLimits.windows);
  const sharedResetStr = formatUsageResetDate(sharedReset, timestampFormat);

  return (
    <div className={cn("grid gap-3", props.className)}>
      {usageLimits.windows.map((window) => {
        const color = usageBarColor(window.usedPercent);
        // The bar width and the "% remaining" label must derive from the same
        // rounded number. Deriving the label from a rounded value and the bar
        // from the raw one makes 99.6% read as "0% remaining" next to a bar
        // that is visibly not full.
        const roundedPercent = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
        const remainingPercent = 100 - roundedPercent;
        const windowKey = getUsageWindowKey(window);
        const resetDateStr = sharedReset
          ? null
          : formatUsageResetDate(window.resetsAt, timestampFormat);

        return (
          <div key={windowKey} className="grid gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">{window.label}</span>
              <span className="text-muted-foreground">{remainingPercent}% remaining</span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={`${window.label} usage ${roundedPercent}% used`}
              aria-valuenow={roundedPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  color,
                )}
                style={{ width: `${roundedPercent}%` }}
              />
            </div>
            {resetDateStr ? (
              <div className="text-[11px] text-muted-foreground">Resets {resetDateStr}</div>
            ) : null}
          </div>
        );
      })}
      {sharedResetStr ? (
        <div className="text-[11px] text-muted-foreground">Resets {sharedResetStr}</div>
      ) : null}
    </div>
  );
}

function QuotaEnvironmentGroup(props: {
  readonly environmentLabel: string | null;
  readonly providers: readonly ServerProvider[];
}) {
  return (
    <div className="grid gap-4">
      {props.environmentLabel ? (
        <h3 className="text-xs tracking-wide text-muted-foreground uppercase">
          {props.environmentLabel}
        </h3>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        {props.providers.map((provider) => {
          const notice = providerQuotaNotice(provider);
          return (
            <div key={provider.instanceId} className="grid gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={providerQuotaLabel(provider)}
                  accentColor={provider.accentColor}
                  showBadge={Boolean(provider.accentColor)}
                  indicatorBackground="var(--background)"
                  className="size-5"
                  iconClassName="size-4 text-foreground/80"
                  badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
                />
                <span className="truncate text-sm font-medium text-foreground">
                  {providerQuotaLabel(provider)}
                </span>
              </div>
              {notice ? (
                <p className="text-xs text-muted-foreground">{notice}</p>
              ) : (
                <ProviderUsageBars usageLimits={provider.usageLimits} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Subscription quota windows from each connected environment's provider CLIs.
 * Independent of the token-cost totals on the rest of the Usage page.
 */
export function ProviderQuotaLimitsSection() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const groups = collectQuotaGroups(configs, presentations);

  if (groups.length === 0) return null;

  return (
    <section className="grid gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">Provider limits</h2>
        <p className="text-xs text-muted-foreground">
          Remaining subscription windows from each provider. Separate from the raw token cost below.
        </p>
      </div>
      {groups.map((group) => (
        <QuotaEnvironmentGroup
          key={group.environmentId}
          environmentLabel={group.environmentLabel}
          providers={group.providers}
        />
      ))}
    </section>
  );
}

export function collectQuotaGroups(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  presentations: ReadonlyMap<
    EnvironmentId,
    { readonly entry: { readonly target: { readonly label: string } } }
  >,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly providers: readonly ServerProvider[];
}> {
  const showEnvironmentLabels = configs.size > 1;
  const groups: Array<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string | null;
    readonly providers: readonly ServerProvider[];
  }> = [];

  for (const [environmentId, config] of configs) {
    const providers = config.providers.filter(shouldShowProviderQuota);
    if (providers.length === 0) continue;
    groups.push({
      environmentId,
      environmentLabel: showEnvironmentLabels
        ? (presentations.get(environmentId)?.entry.target.label ?? environmentId)
        : null,
      providers,
    });
  }

  return groups;
}
