import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsage, refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { summarizeTodayUsage } from "@t3tools/shared/usageToday";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
  UsageBucket,
  UsageProviderKind,
} from "@t3tools/contracts";
import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import { useState, type ReactNode } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { LimitWindows } from "./UsageLimits";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

type DriverLimits = {
  readonly driver: ProviderDriverKind;
  readonly kind: UsageProviderKind;
  readonly windows: NonNullable<ServerProvider["usageLimits"]>["windows"];
  readonly checkedAt: string;
};

function selectedDriverLimits(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
): Map<ProviderDriverKind, DriverLimits> {
  const byDriver = new Map<ProviderDriverKind, DriverLimits>();
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const windows = provider.usageLimits?.windows ?? [];
      if (windows.length === 0 || byDriver.has(provider.driver)) continue;
      const kind = (Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[]).find(
        (candidate) => PROVIDER_PRESENTATION[candidate].driverKind === provider.driver,
      );
      if (kind === undefined) continue;
      byDriver.set(provider.driver, {
        driver: provider.driver,
        kind,
        windows: [...windows],
        checkedAt: provider.usageLimits?.checkedAt ?? "",
      });
    }
  }
  return byDriver;
}

export function QuickUsagePopover({
  trigger,
  onOpenFull,
}: {
  readonly trigger?: ReactNode;
  readonly onOpenFull?: () => void;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [selectedProvider, setSelectedProvider] = useState<UsageProviderKind | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const todayWindow = makeWindow(8, new Date(now));
  const usage = useUsage(todayWindow);
  const merged = usage.shown?.merged ?? usage.merged;
  const buckets: UsageBucket[] = merged.daily.map((day) => ({
    day: day.day as UsageBucket["day"],
    provider: "codex" as const,
    model: "aggregate",
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: day.costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced" as const,
    records: 0,
    unpricedRecords: 0,
    sessions: 0,
  }));
  const todaySummary = summarizeTodayUsage(
    buckets,
    new Date(now),
    usage.shown?.window.timeZone ?? todayWindow.timeZone,
  );

  const byDriver = selectedDriverLimits(presentations);
  const providers = PROVIDER_ORDER.map((kind) =>
    byDriver.get(PROVIDER_PRESENTATION[kind].driverKind),
  ).filter((entry): entry is DriverLimits => entry !== undefined);

  let best: DriverLimits | undefined;
  let bestRemaining = Number.POSITIVE_INFINITY;
  for (const provider of providers) {
    const remaining = Math.min(...provider.windows.map((window) => remainingPercent(window)));
    if (remaining < bestRemaining) {
      best = provider;
      bestRemaining = remaining;
    }
  }
  const defaultProvider = best?.kind ?? null;

  const selected =
    (selectedProvider === null
      ? undefined
      : providers.find((provider) => provider.kind === selectedProvider)) ??
    providers.find((provider) => provider.kind === defaultProvider);
  const latestCheckedAt = providers.reduce<string | null>((latest, provider) => {
    if (!provider.checkedAt) return latest;
    return latest === null || Date.parse(provider.checkedAt) > Date.parse(latest)
      ? provider.checkedAt
      : latest;
  }, null);
  const updated =
    latestCheckedAt === null || !Number.isFinite(Date.parse(latestCheckedAt))
      ? null
      : `updated ${new Date(latestCheckedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;

  const refresh = () => {
    void settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              false,
            );
          }
          return undefined;
        }),
      ),
    )
      .then(() =>
        refreshUsage({
          registry: appAtomRegistry,
          server: serverEnvironment,
          presentations: environmentPresentations,
          environmentIds: usage.selectedEnvironments.map(({ environmentId }) => environmentId),
          input: todayWindow,
        }),
      )
      .then(() => {
        setNow(Date.now());
      });
  };

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label="Usage" />}>
        {trigger ?? "Usage"}
      </PopoverTrigger>
      <PopoverPopup width="lg">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <PopoverTitle>Usage</PopoverTitle>
            <span className="ms-auto text-xs text-muted-foreground tabular-nums">
              {updated ?? ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh usage"
              onClick={refresh}
            >
              <RefreshIcon size="xs" />
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage limits reported yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Providers">
                {providers.map((provider) => (
                  <button
                    key={provider.kind}
                    type="button"
                    aria-pressed={selected?.kind === provider.kind}
                    onClick={() => {
                      setSelectedProvider(provider.kind);
                    }}
                    className="rounded-full border border-input px-2.5 py-1 text-xs font-medium data-pressed:bg-accent"
                    data-pressed={selected?.kind === provider.kind ? true : undefined}
                  >
                    {PROVIDER_PRESENTATION[provider.kind].label}
                  </button>
                ))}
              </div>

              <div aria-label="Usage windows" className="flex flex-col gap-1">
                {selected ? (
                  <LimitWindows
                    driver={selected.driver}
                    windows={selected.windows}
                    now={now}
                    compact
                  />
                ) : null}
              </div>

              {todaySummary ? (
                <p className="text-xs text-muted-foreground tabular-nums">
                  Spent today: {formatUsd(todaySummary.todayCostUsd)} / pace{" "}
                  {formatUsd(todaySummary.paceUsd)}
                  {todaySummary.deltaPercent === null ? null : (
                    <>
                      {" "}
                      ▓▓▓▓▓▓
                      {todaySummary.deltaPercent <= 0
                        ? ` (${Math.abs(Math.round(todaySummary.deltaPercent))}% under)`
                        : ` (${Math.round(todaySummary.deltaPercent)}% over)`}
                    </>
                  )}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onOpenFull?.();
                  }}
                >
                  View more
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
