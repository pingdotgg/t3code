import type {
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectProviderUsageLimits,
  formatDuration,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, SquareTerminalIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useNewTerminalTab } from "../workspaceTabs/WorkspaceSurfaceView";

// Layout and wording follow monocode's usage footer, chips and popover (MIT).
const FOOTER_BUTTON_CLASS =
  "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-foreground/55 outline-hidden transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const WINDOW_TITLE: Partial<Record<ServerProviderUsageWindow["kind"], string>> = {
  session: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};

const EMPTY_SOURCES: UsageLimitSourceSnapshots = [];

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? String(provider.driver);
}

function hasLimits(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.usageLimits !== undefined &&
    provider.usageLimits.unavailable?.reason !== "unsupported"
  );
}

function barClass(left: number): string {
  if (left <= 10) return "bg-red-400";
  if (left <= 20) return "bg-amber-400";
  return "bg-foreground/45";
}

function resetLabel(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return resetsAt > now ? formatDuration(resetsAt - now) : null;
}

function updatedLabel(checkedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 60_000));
  if (!Number.isFinite(minutes) || minutes === 0) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

function limitsFor(
  provider: ServerProvider,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ServerProviderUsageLimits | undefined {
  // Only this instance's login: another report entry may be a different account.
  return (
    collectProviderUsageLimits(provider.instanceId, providers, sources, now)?.accounts.find(
      (account) => account.instanceId === provider.instanceId,
    )?.limits ?? provider.usageLimits
  );
}

/** The bar under the routed card: every agent's room left, and a terminal tab, as in monocode. */
export function UsageFooter() {
  const config = useAtomValue(primaryServerConfigAtom);
  const environmentId = usePrimaryEnvironmentId();
  const newTerminalTab = useNewTerminalTab();
  const nowMinute = useNowMinute();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const providers = config?.providers ?? [];
  const sources = config?.usageLimitSources ?? EMPTY_SOURCES;
  const withLimits = providers.filter(hasLimits);
  // Keeps the gap under the routed card that the footer otherwise fills.
  if (withLimits.length === 0 && !newTerminalTab) return <div className="hidden h-1.5 md:block" />;
  const now = Date.parse(`${nowMinute}:00Z`);

  const refresh = () => {
    if (!environmentId || refreshing) return;
    setRefreshing(true);
    void refreshProviders({ environmentId, input: { refreshUsageLimits: true } }).finally(() =>
      setRefreshing(false),
    );
  };

  return (
    <footer
      aria-label="Provider usage"
      className="hidden h-7.5 shrink-0 items-center gap-1.5 overflow-x-auto pb-0.5 text-2xs text-foreground/55 md:flex"
    >
      {withLimits.map((provider) => (
        <ProviderUsageChip
          key={provider.instanceId}
          provider={provider}
          limits={limitsFor(provider, providers, sources, now)}
          now={now}
        />
      ))}
      {withLimits.length > 0 ? (
        <button
          type="button"
          aria-label="Refresh usage"
          disabled={refreshing || !environmentId}
          onClick={refresh}
          className="-ml-1 grid size-5 shrink-0 place-items-center rounded-full text-foreground/40 outline-hidden hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50"
        >
          <RefreshCwIcon aria-hidden className={cn("size-2.5", refreshing && "animate-spin")} />
        </button>
      ) : null}
      {newTerminalTab ? (
        <button
          type="button"
          onClick={newTerminalTab}
          className={cn(FOOTER_BUTTON_CLASS, "ml-auto text-foreground/40")}
        >
          <SquareTerminalIcon aria-hidden className="size-3.5" />
          Terminal
        </button>
      ) : null}
    </footer>
  );
}

function ProviderUsageChip({
  provider,
  limits,
  now,
}: {
  readonly provider: ServerProvider;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly now: number;
}) {
  const windows = limits?.windows ?? [];
  // The first session and weekly windows; model-scoped weeklies stay in the popover.
  const picked = (["session", "weekly"] as const).flatMap((kind) => {
    const window = windows.find((entry) => entry.kind === kind);
    return window ? [window] : [];
  });
  const shown = picked.length > 0 ? picked : windows.slice(0, 2);
  const tightest = shown.reduce<number | null>(
    (lowest, window) => Math.min(lowest ?? 100, remainingPercent(window)),
    null,
  );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${providerLabel(provider)} usage details`}
            className={FOOTER_BUTTON_CLASS}
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={providerLabel(provider)}
          accentColor={provider.accentColor}
          size="compact"
        />
        {tightest === null ? (
          <span className="text-foreground/35">{limits?.unavailable ? "Unavailable" : "···"}</span>
        ) : (
          <>
            <span
              aria-hidden
              className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-foreground/10"
            >
              <span
                className={cn("block h-full rounded-full", barClass(tightest))}
                style={{ width: `${tightest}%` }}
              />
            </span>
            <span className="flex items-center gap-1 tabular-nums">
              {shown.map((window, index) => (
                <span key={window.id} className="inline-flex items-center gap-1">
                  {index > 0 ? <span className="text-foreground/25">·</span> : null}
                  {remainingPercent(window)}% {resetLabel(window, now) ?? window.label}
                </span>
              ))}
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="sm">
        <div className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto">
          <Link
            to="/usage"
            className="self-start text-3xs text-foreground/45 hover:text-foreground"
          >
            Open usage
          </Link>
          <div className="flex items-center gap-2.5 px-1 pt-0.5 pb-1">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground/6 ring-1 ring-foreground/7 ring-inset">
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={providerLabel(provider)}
                accentColor={provider.accentColor}
              />
            </span>
            <div className="min-w-0">
              <h2 className="font-medium text-xs leading-4">{providerLabel(provider)} usage</h2>
              {limits ? (
                <p className="mt-0.5 text-3xs text-foreground/40 leading-4">
                  {limits.unavailable?.message ?? updatedLabel(limits.checkedAt, now)}
                </p>
              ) : null}
            </div>
          </div>
          {windows.map((window) => (
            <UsageWindowCard key={window.id} window={window} now={now} />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function UsageWindowCard({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const left = remainingPercent(window);
  const title = window.label.includes("·")
    ? window.label
    : (WINDOW_TITLE[window.kind] ?? window.label);
  const reset = resetLabel(window, now);
  return (
    <section className="rounded-lg bg-foreground/4.5 px-3 py-2.5 ring-1 ring-foreground/6 ring-inset">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-2xs text-foreground/65">{title}</h3>
        <span className="shrink-0 font-medium text-2xs tabular-nums">{left}% remaining</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={`${title} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        <span
          className={cn("block h-full rounded-full", barClass(left))}
          style={{ width: `${left}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-3xs text-foreground/40 leading-4">
        <span className="tabular-nums">{100 - left}% used</span>
        <span className="truncate text-right tabular-nums">
          {reset ? `Resets in ${reset}` : null}
        </span>
      </div>
    </section>
  );
}
