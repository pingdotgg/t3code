import type {
  ServerProvider,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitsGroups,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  type LimitPace,
  paceOf,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** The series colour the cost chart uses for this driver, so the two views read as one. */
function barColor(driver: ServerProvider["driver"]): string {
  const kind: UsageProviderKind | undefined =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
  return kind ? PROVIDER_PRESENTATION[kind].color : "var(--foreground)";
}

/** Pace as a glyph with the words on hover. */
function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * The fill is the share of quota spent; the hairline is how far into the
 * window the clock is, which is also where even spending would have put the
 * fill. Hover for the exact figures and reset time.
 */
function WindowBar({
  color,
  window,
  now,
}: {
  readonly color: string;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const elapsed = elapsedShare(window, now);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  const summary = `${window.label}: ${Math.round(used)}% used${
    elapsed === null ? "" : `, ${Math.round(elapsed * 100)}% of the window elapsed`
  }${resetsIn ? `, ${resetsIn}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {used > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${used}%`, backgroundColor: color }}
          />
        ) : null}
        {elapsed !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {Math.round(used)}% used
            {elapsed !== null ? ` · ${Math.round(elapsed * 100)}% of the window elapsed` : ""}
          </span>
          {elapsed !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** One provider's windows as rows: label and percent, bar, pace and countdown. */
function ProviderWindows({
  provider,
  now,
}: {
  readonly provider: ServerProvider;
  readonly now: number;
}) {
  const windows = provider.usageLimits?.windows ?? [];
  const color = barColor(provider.driver);
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1">
      {windows.map((window, index) => {
        // Windows that reset together show the countdown once.
        const previous = windows[index - 1];
        const sharesReset =
          previous?.resetsAt !== undefined && previous.resetsAt === window.resetsAt;
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {Math.round(window.usedPercent)}%
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{sharesReset ? "" : (resetsIn ?? "")}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function ProviderLimits({
  provider,
  now,
}: {
  readonly provider: ServerProvider;
  readonly now: number;
}) {
  const limits = provider.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);
  const label = providerLimitsLabel(provider, (driver) => getDriverOption(driver)?.label);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={label}
          accentColor={provider.accentColor}
          showBadge={Boolean(provider.accentColor)}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <span className="truncate">{label}</span>
        {provider.auth.label ? (
          <span className="shrink-0 font-normal text-muted-foreground">
            · {provider.auth.label}
          </span>
        ) : null}
      </h2>
      {notice ? (
        <span className="text-xs text-muted-foreground">{notice}</span>
      ) : (
        <ProviderWindows provider={provider} now={now} />
      )}
    </section>
  );
}

/**
 * Subscription quota windows from every connected environment's providers.
 * Countdowns anchor to render time rather than ticking: a live clock would
 * repaint the page every minute for no decision-changing gain.
 */
export function UsageLimitsSection() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const groups = collectLimitsGroups(presentations);
  const now = Date.now();

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No provider on a connected environment reports subscription limits.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <div key={group.environmentId} className="flex flex-col gap-6">
          {group.environmentLabel ? (
            <h2 className="text-xs tracking-wide text-muted-foreground uppercase">
              {group.environmentLabel}
            </h2>
          ) : null}
          {group.providers.map((provider) => (
            <ProviderLimits key={provider.instanceId} provider={provider} now={now} />
          ))}
        </div>
      ))}
    </div>
  );
}
