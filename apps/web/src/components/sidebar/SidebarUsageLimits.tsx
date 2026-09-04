import type {
  ProviderDriverKind,
  ServerConfig,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageProviderKind,
} from "@t3tools/contracts";
import { formatResetsIn, providerLimitsLabel } from "@t3tools/shared/usageLimits";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThread } from "../../state/entities";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

function compactDuration(minutes: number | undefined): string | null {
  if (minutes === undefined) return null;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function compareWindowDuration(
  left: ServerProviderUsageWindow,
  right: ServerProviderUsageWindow,
): number {
  return (
    (left.windowDurationMins ?? Number.POSITIVE_INFINITY) -
    (right.windowDurationMins ?? Number.POSITIVE_INFINITY)
  );
}

function providerColor(driver: ProviderDriverKind): string {
  const kind: UsageProviderKind | null =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : null;
  return kind === null ? "var(--sidebar-foreground)" : PROVIDER_PRESENTATION[kind].color;
}

function normalizedEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email ? email : null;
}

function sourceAccountForProvider(
  config: ServerConfig,
  provider: ServerProvider,
): UsageLimitSourceAccount | null {
  const accounts = (config.usageLimitSources ?? []).flatMap((source) => source.accounts);
  const sameDriver = accounts.filter((account) => account.driver === provider.driver);
  const providerEmail = normalizedEmail(provider.auth.email);
  if (providerEmail !== null) {
    return sameDriver.find((account) => normalizedEmail(account.email) === providerEmail) ?? null;
  }
  return sameDriver.length === 1 ? (sameDriver[0] ?? null) : null;
}

function limitsForProvider(
  config: ServerConfig,
  provider: ServerProvider,
): ServerProviderUsageLimits | null {
  if (
    provider.usageLimits !== undefined &&
    provider.usageLimits.unavailable === undefined &&
    provider.usageLimits.windows.length > 0
  ) {
    return provider.usageLimits;
  }
  const sourceAccount = sourceAccountForProvider(config, provider);
  if (
    sourceAccount?.usageLimits.unavailable === undefined &&
    sourceAccount?.usageLimits.windows.length
  ) {
    return sourceAccount.usageLimits;
  }
  return null;
}

function windowLabel(window: ServerProviderUsageWindow): string {
  const duration = compactDuration(window.windowDurationMins);
  return duration === null ? window.label : `${window.label} · ${duration}`;
}

function UsageWindowBar({
  window,
  color,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly now: number;
}) {
  const remaining = remainingPercent(window);
  const reset = formatResetsIn(window, now);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[11px] leading-none">
        <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">
          {windowLabel(window)}
        </span>
        <span className="shrink-0 font-medium text-sidebar-foreground tabular-nums">
          {Math.round(remaining)}% left
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-control-surface">
        <div
          className="h-full rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
      </div>
      {reset ? (
        <span className="text-[10px] leading-none text-sidebar-muted-foreground/70 tabular-nums">
          {reset}
        </span>
      ) : null}
    </div>
  );
}

export function SidebarUsageLimits() {
  const enabled = useClientSettings((settings) => settings.sidebarUsageLimitsEnabled);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, draftSession),
    [draftSession, routeTarget],
  );
  const activeThread = useThread(routeThreadRef);
  const composerDraft = useComposerDraftStore((store) => {
    if (routeTarget?.kind === "draft") return store.getComposerDraft(routeTarget.draftId);
    if (routeTarget?.kind === "server") return store.getComposerDraft(routeTarget.threadRef);
    return null;
  });
  const serverConfigs = useServerConfigs();
  const environmentId =
    routeTarget?.kind === "server"
      ? routeTarget.threadRef.environmentId
      : (draftSession?.environmentId ?? null);
  const instanceId =
    composerDraft?.activeProvider ??
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    null;
  const config = environmentId === null ? undefined : serverConfigs.get(environmentId);
  const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
  const limits = enabled && config && provider ? limitsForProvider(config, provider) : null;
  if (!limits || !provider) return null;
  const now = Date.parse(limits.checkedAt);
  const windows = limits.windows.toSorted(compareWindowDuration);
  const shortestWindow = windows[0];
  if (!shortestWindow) return null;
  const color = providerColor(provider.driver);
  const providerLabel = providerLimitsLabel(provider, (driver) => getDriverOption(driver)?.label);
  const shortestRemaining = remainingPercent(shortestWindow);
  const shortestDuration = compactDuration(shortestWindow.windowDurationMins);
  const summary = `${providerLabel} ${shortestWindow.label}: ${Math.round(shortestRemaining)}% left`;

  return (
    <div className="group/sidebar-usage relative">
      <div
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="flex cursor-default flex-col gap-1.5 rounded-md px-2 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none">
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={providerLabel}
            accentColor={provider.accentColor}
            showBadge={Boolean(provider.accentColor)}
            indicatorBackground="var(--sidebar)"
            className="size-3.5 shrink-0"
            iconClassName="size-3 text-sidebar-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">
            {providerLabel}
            {shortestDuration ? ` · ${shortestDuration}` : ""}
          </span>
          <span className="shrink-0 font-medium text-sidebar-foreground tabular-nums">
            {Math.round(shortestRemaining)}% left
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-sidebar-control-surface">
          <div
            className="h-full rounded-full"
            style={{ width: `${shortestRemaining}%`, backgroundColor: color }}
          />
        </div>
      </div>
      <div className="pointer-events-none invisible absolute inset-x-0 bottom-full z-50 pb-1 opacity-0 transition-opacity group-focus-within/sidebar-usage:pointer-events-auto group-focus-within/sidebar-usage:visible group-focus-within/sidebar-usage:opacity-100 group-hover/sidebar-usage:pointer-events-auto group-hover/sidebar-usage:visible group-hover/sidebar-usage:opacity-100">
        <div className="flex flex-col gap-3 rounded-lg border border-sidebar-border bg-sidebar p-3 text-sidebar-foreground shadow-lg">
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={providerLabel}
              accentColor={provider.accentColor}
              showBadge={Boolean(provider.accentColor)}
              indicatorBackground="var(--sidebar)"
              className="size-4 shrink-0"
              iconClassName="size-3.5 text-sidebar-foreground/80"
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {providerLabel} limits
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {windows.map((window) => (
              <UsageWindowBar key={window.id} window={window} color={color} now={now} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
