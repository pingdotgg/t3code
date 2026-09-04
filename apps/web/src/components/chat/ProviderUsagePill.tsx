import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  highestUsageWindow,
  providersWithReportedUsage,
  selectCollapsedUsageProvider,
  type ProviderWithReportedUsage,
} from "./ProviderUsagePill.logic";

function providerLabel(provider: ServerProvider): string {
  return (
    provider.displayName?.trim() ||
    getDriverOption(provider.driver)?.label ||
    String(provider.driver)
  );
}

function roundedUsage(usedPercent: number): number {
  return Math.round(Math.max(0, Math.min(100, usedPercent)));
}

function windowColor(provider: ServerProvider): string {
  return provider.accentColor ?? "var(--foreground)";
}

function UsageWindowRow({
  provider,
  window,
  now,
}: {
  readonly provider: ProviderWithReportedUsage;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const used = roundedUsage(window.usedPercent);
  const resetsIn = formatResetsIn(window, now);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{window.label}</span>
        <span className="shrink-0 font-medium text-foreground tabular-nums">{used}% used</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.label}: ${used}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        className="h-1.5 overflow-hidden rounded-full bg-muted/70"
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${used}%`, backgroundColor: windowColor(provider) }}
        />
      </div>
      {resetsIn ? (
        <span className="self-end text-[11px] leading-none text-secondary-label tabular-nums">
          {resetsIn}
        </span>
      ) : null}
    </div>
  );
}

function ProviderTab({
  provider,
  selected,
  onSelect,
}: {
  readonly provider: ProviderWithReportedUsage;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const label = providerLabel(provider);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`${label} usage`}
      onClick={onSelect}
      className={cn(
        "relative flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-background text-foreground shadow-xs ring-1 ring-border/70"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={label}
        className="size-4"
        iconClassName="size-3.5"
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function ProviderUsagePill({
  providers,
  activeProviderInstanceId,
}: {
  readonly providers: readonly ServerProvider[];
  readonly activeProviderInstanceId: ProviderInstanceId | null;
}) {
  const usageProviders = useMemo(() => providersWithReportedUsage(providers), [providers]);
  const collapsedProvider = useMemo(
    () => selectCollapsedUsageProvider(usageProviders, activeProviderInstanceId),
    [activeProviderInstanceId, usageProviders],
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    collapsedProvider?.instanceId ?? null,
  );
  const [now, setNow] = useState(() => Date.now());

  if (collapsedProvider === null) return null;

  const selectedProvider =
    usageProviders.find((provider) => provider.instanceId === selectedInstanceId) ??
    collapsedProvider;
  const label = providerLabel(collapsedProvider);
  const collapsedUsage = roundedUsage(highestUsageWindow(collapsedProvider).usedPercent);
  const selectedLabel = providerLabel(selectedProvider);
  const updated = formatRelativeTimeLabel(selectedProvider.usageLimits.checkedAt);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${label} usage: ${collapsedUsage}% used`}
            onClick={() => {
              setSelectedInstanceId(collapsedProvider.instanceId);
              setNow(Date.now());
            }}
            className="group/usage-pill relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full border border-border/70 bg-secondary/80 px-2.5 text-xs font-medium text-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow,scale] [-webkit-app-region:no-drag] hover:border-border hover:bg-secondary active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring data-pressed:bg-accent"
          >
            <ProviderInstanceIcon
              driverKind={collapsedProvider.driver}
              displayName={label}
              className="size-4"
              iconClassName="size-3.5 text-foreground/80"
            />
            <span className="hidden max-w-20 truncate text-muted-foreground sm:inline">
              {label}
            </span>
            <span className="tabular-nums">{collapsedUsage}%</span>
            <span
              aria-hidden
              className="absolute inset-x-2 bottom-0 h-px origin-left rounded-full bg-foreground/45"
              style={{ transform: `scaleX(${collapsedUsage / 100})` }}
            />
          </button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="center"
        sideOffset={6}
        className="w-[min(22rem,calc(100vw-1rem))] max-w-none"
        viewportClassName="p-0"
      >
        <div className="flex flex-col">
          {usageProviders.length > 1 ? (
            <div
              role="tablist"
              aria-label="Provider usage"
              className="flex gap-1 border-b border-border/70 bg-muted/30 p-1.5"
            >
              {usageProviders.map((provider) => (
                <ProviderTab
                  key={provider.instanceId}
                  provider={provider}
                  selected={provider.instanceId === selectedProvider.instanceId}
                  onSelect={() => setSelectedInstanceId(provider.instanceId)}
                />
              ))}
            </div>
          ) : null}

          <div
            role="tabpanel"
            aria-label={`${selectedLabel} usage limits`}
            className="flex flex-col gap-4 p-4"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ProviderInstanceIcon
                driverKind={selectedProvider.driver}
                displayName={selectedLabel}
                accentColor={selectedProvider.accentColor}
                showBadge={Boolean(selectedProvider.accentColor)}
                indicatorBackground="var(--popover)"
                className="size-5"
                iconClassName="size-4.5"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{selectedLabel}</div>
                {selectedProvider.auth.label ? (
                  <div className="truncate text-[11px] text-secondary-label">
                    {selectedProvider.auth.label}
                  </div>
                ) : null}
              </div>
              {updated ? (
                <span className="shrink-0 text-[11px] text-secondary-label">Updated {updated}</span>
              ) : null}
            </div>

            <div className="flex flex-col gap-3.5">
              {selectedProvider.usageLimits.windows.map((window) => (
                <UsageWindowRow
                  key={window.id}
                  provider={selectedProvider}
                  window={window}
                  now={now}
                />
              ))}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
