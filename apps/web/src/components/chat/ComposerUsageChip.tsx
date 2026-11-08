import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

// Layout and wording follow monocode's usage chip and popover (MIT).
const WINDOW_TITLE: Partial<Record<ServerProviderUsageWindow["kind"], string>> = {
  session: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "Monthly limit",
};

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

/**
 * The current agent's room left beside the composer. It opens every agent's limits,
 * so all subscriptions stay one glance away.
 */
export function ComposerUsageChip({
  providerInstanceId,
  providers,
  sources,
}: {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}) {
  const nowMinute = useNowMinute();
  const withLimits = providers.filter(hasLimits);
  if (withLimits.length === 0) return null;
  const now = Date.parse(`${nowMinute}:00Z`);
  const current =
    withLimits.find((provider) => provider.instanceId === providerInstanceId) ?? withLimits[0]!;
  const windows = limitsFor(current, providers, sources, now)?.windows ?? [];
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
            aria-label={`${providerLabel(current)} usage details`}
            className="inline-flex h-6.5 items-center gap-1.5 whitespace-nowrap rounded-md bg-background/45 px-1.5 text-foreground/60 text-xs outline-hidden ring-1 ring-foreground/8 backdrop-blur-md transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={current.driver}
          displayName={providerLabel(current)}
          accentColor={current.accentColor}
          size="compact"
        />
        {tightest === null ? (
          <span className="text-foreground/35">No limits</span>
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
      <PopoverPopup side="top" align="end" width="sm">
        <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto">
          <Link
            to="/usage"
            className="self-start text-2xs text-foreground/45 hover:text-foreground"
          >
            Open usage
          </Link>
          {withLimits.map((provider) => (
            <ProviderUsage
              key={provider.instanceId}
              provider={provider}
              limits={limitsFor(provider, providers, sources, now)}
              now={now}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ProviderUsage({
  provider,
  limits,
  now,
}: {
  readonly provider: ServerProvider;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly now: number;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5 px-1 pb-1">
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
      {(limits?.windows ?? []).map((window) => (
        <UsageWindowCard key={window.id} window={window} now={now} />
      ))}
    </section>
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
