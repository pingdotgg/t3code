import {
  type EnvironmentId,
  isProviderAvailable,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  formatResetsIn,
  formatRunsOutIn,
  isLowLimit,
  limitsNotice,
  remainingPercent,
  tightestSessionLimit,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon, InfoIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { Badge } from "../ui/badge";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (account.email?.trim()) return account.email.trim();
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase() ? String(instance) : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {account.email || label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full wrap-anywhere font-sans text-meta"
        />
      ) : (
        <Text variant="meta">{label}</Text>
      )}
      {account.instanceId && label !== driver ? (
        <Text variant="meta" tone="muted">
          {driver}
        </Text>
      ) : null}
      {account.plan ? (
        <Text variant="meta" tone="dim">
          {account.plan}
        </Text>
      ) : null}
    </span>
  );
}

function providerName(driver: ServerProvider["driver"], displayName?: string | null): string {
  return displayName?.trim() || providerClients.get(driver)?.label || String(driver);
}

/** `Codex at 82% of the 5 hour window`: how much of the window is spent. */
function formatLimitSummary(
  driver: ServerProvider["driver"],
  window: ServerProviderUsageWindow,
): string {
  return `${providerName(driver)} at ${100 - remainingPercent(window)}% of the ${window.label.toLowerCase()} window`;
}

/** The tightest window in a report, for its one-line summary. */
function tightestReportWindow(report: UsageLimitsReport) {
  let tightest: {
    readonly driver: ServerProvider["driver"];
    readonly window: ServerProviderUsageWindow;
  } | null = null;
  for (const account of report.accounts) {
    if (limitsNotice(account.limits) !== null) continue;
    for (const window of account.limits.windows) {
      if (tightest === null || remainingPercent(window) < remainingPercent(tightest.window)) {
        tightest = { driver: account.driver, window };
      }
    }
  }
  return tightest;
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const tightest = tightestReportWindow(report);
  // The line names the tightest window; each account's block follows below it.
  const summary = tightest ? (
    formatLimitSummary(tightest.driver, tightest.window)
  ) : single ? (
    <AccountSummary account={single} />
  ) : (
    `${report.accounts.length} accounts`
  );
  return {
    id,
    variant: tightest && isLowLimit(tightest.window) ? "warning" : "info",
    icon: <GaugeIcon />,
    title: "Usage limits",
    description: summary,
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

export function modelFallbackBannerItem({
  fallbackModelName,
  defaultProviderName,
  defaultModelName,
  resetsAt,
  timestampFormat,
  onUseDefault,
  onDismiss,
}: {
  readonly fallbackModelName: string;
  readonly defaultProviderName: string;
  readonly defaultModelName: string;
  readonly resetsAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onUseDefault: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: `Using ${fallbackModelName}`,
    description: (
      <span className="inline-flex flex-col">
        <span>{defaultProviderName} is out of usage</span>
        {resetsAt ? <span>Resets {formatUpcomingTimestamp(resetsAt, timestampFormat)}</span> : null}
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        Use {defaultModelName}
      </Button>
    ),
    dismissLabel: "Dismiss fallback model notice",
    onDismiss,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-3 ps-0 pt-0.5 pb-1.5 pe-2">
        <UsageLimitsAccounts report={report} environmentId={environmentId} />
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}

function UsageLimitsAccounts({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <>
      {[false, true].map((unavailable) => {
        const accounts = report.accounts.filter(
          (account) => (account.limits.unavailable?.reason === "unsupported") === unavailable,
        );
        if (accounts.length === 0) return null;
        return (
          <section
            key={String(unavailable)}
            className="flex min-w-0 flex-col gap-3"
            aria-label={unavailable ? "Connections" : "Reported usage"}
          >
            {report.accounts.some(
              (account) => account.limits.unavailable?.reason === "unsupported",
            ) ? (
              <Text variant="meta" tone="dim">
                {unavailable ? "Connections" : "Reported usage"}
              </Text>
            ) : null}
            {accounts.map((account) => {
              const resetCreditInput =
                account.resetCreditInput ??
                (account.instanceId ? { instanceId: account.instanceId } : undefined);
              const notice =
                account.limits.unavailable?.reason === "unsupported"
                  ? "Usage unavailable for this API connection"
                  : limitsNotice(account.limits);
              const externalUsage = account.limits.externalUsage;
              return (
                <div key={account.id} className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-start gap-2">
                    <AccountSummary account={account} />
                    {account.sourceLabel ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label="Account source and ID"
                            />
                          }
                        >
                          <InfoIcon />
                        </TooltipTrigger>
                        <TooltipPopup>
                          <div className="flex flex-col gap-1">
                            <Text variant="meta">Source: {account.sourceLabel}</Text>
                            <Text variant="meta">Account ID: {account.id}</Text>
                          </div>
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                  {notice ? (
                    <Text variant="meta" tone="muted">
                      {notice}
                    </Text>
                  ) : (
                    <LimitWindows
                      compact
                      driver={account.driver}
                      accentColor={account.accentColor}
                      windows={account.limits.windows}
                      now={now}
                    />
                  )}
                  {externalUsage ? (
                    <Button
                      size="sm"
                      variant="link"
                      className="self-start"
                      onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                    >
                      Manage usage
                    </Button>
                  ) : null}
                  {resetCreditInput && account.limits.resetCredits ? (
                    <ResetCredits
                      environmentId={environmentId}
                      input={resetCreditInput}
                      credits={account.limits.resetCredits}
                      now={now}
                    />
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
      {report.notices.map((notice) => (
        <span key={notice} className="text-meta text-muted-foreground">
          {notice}
        </span>
      ))}
    </>
  );
}

/** The governing limit for the selected model, pooled across reported accounts. */
export interface LowLimitSignal {
  /** The watched window; a dismissal lasts until that window resets. */
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly window: ServerProviderUsageWindow;
  /** When the usage was read. */
  readonly checkedAt: string;
}

/** The session window an instance reports for its own signed-in account. */
function ownSessionLimit(provider: ServerProvider) {
  const limits = provider.usageLimits;
  if (!limits || limitsNotice(limits) !== null) return null;
  return tightestSessionLimit([
    {
      key: String(provider.instanceId),
      driver: provider.driver,
      displayName: null,
      email: undefined,
      plan: undefined,
      accentColor: undefined,
      environments: [],
      sourceLabel: null,
      redeem: null,
      limits,
    },
  ]);
}

export function resolveLowLimitSignal(
  provider: ServerProvider | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  environmentId: EnvironmentId,
  model?: string,
  now = Date.now(),
): LowLimitSignal | null {
  if (!provider) return null;
  const accounts = collectLimitAccounts(
    new Map([
      [
        environmentId,
        {
          entry: { target: { label: "" } },
          serverConfig: { providers, usageLimitSources: sources },
        },
      ],
    ]),
  ).filter((account) => account.driver === provider.driver);
  const active = accounts.map((account) => ({
    ...account,
    limits: {
      ...account.limits,
      windows: account.limits.windows.filter(
        (window) => !window.resetsAt || !(Date.parse(window.resetsAt) <= now),
      ),
    },
  }));
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const selected = `_${normalize(model ?? "")}_`;
  const scoped = new Set(
    active
      .flatMap((account) => account.limits.windows)
      .filter(
        (window) =>
          provider.driver === "claudeAgent" &&
          window.id.startsWith("seven_day_") &&
          selected.includes(`_${window.id.slice("seven_day_".length)}_`),
      )
      .map((window) => window.id),
  );
  const applicable = active.map((account) => ({
    ...account,
    limits: {
      ...account.limits,
      windows: account.limits.windows.filter(
        (window) =>
          provider.driver !== "claudeAgent" ||
          (window.id.startsWith("seven_day_")
            ? scoped.has(window.id)
            : window.id !== "seven_day" || scoped.size === 0),
      ),
    },
  }));
  const pool = collectLimitPools(applicable, now)[0];
  const pooled = pool?.windows.toSorted(
    (left, right) => left.remainingPercent - right.remainingPercent,
  )[0];
  const single = accounts.length <= 1 ? ownSessionLimit(provider) : null;
  const window: ServerProviderUsageWindow | undefined =
    single?.window ??
    (pooled
      ? {
          id: pooled.id,
          kind: pooled.kind,
          label: pooled.label,
          usedPercent: 100 - pooled.remainingPercent,
          resetsAt: pooled.resets[0]?.member.window.resetsAt,
        }
      : undefined);
  // Pool members are read together; the newest read is the one that can show a new window.
  const checkedAt =
    single?.account.limits.checkedAt ??
    active
      .map((account) => account.limits.checkedAt)
      .toSorted()
      .at(-1);
  if (
    !window ||
    !checkedAt ||
    !isLowLimit(window) ||
    (window.resetsAt && Date.parse(window.resetsAt) <= now)
  )
    return null;
  return {
    // Which account is tightest and its reported reset time both shift between usage reads.
    key: [environmentId, provider.instanceId, window.id].join("\u0000"),
    driver: provider.driver,
    window,
    checkedAt,
  };
}

/**
 * Another ready provider to move to: one whose own session is not low, the
 * roomiest first. Providers that report no limits come after those that do.
 */
export function resolveLowLimitSwitchTarget(
  current: ServerProvider,
  providers: readonly ServerProvider[],
): ServerProvider | null {
  const candidates = providers.flatMap((provider) => {
    if (
      provider.driver === current.driver ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      !isProviderAvailable(provider) ||
      provider.models.length === 0
    ) {
      return [];
    }
    const limits = ownSessionLimit(provider);
    if (limits && isLowLimit(limits.window)) return [];
    return [{ provider, remaining: limits?.remainingPercent ?? -1 }];
  });
  candidates.sort((left, right) => right.remaining - left.remaining);
  return candidates[0]?.provider ?? null;
}

/** Each dismissed window's reset time, by signal key. */
export type LowLimitDismissals = ReadonlyMap<string, number | null>;

// Session-scoped so a remount does not bring a dismissed notice back before its window resets.
let sessionLowLimitDismissals: LowLimitDismissals = new Map();

export function readLowLimitDismissals(): LowLimitDismissals {
  return sessionLowLimitDismissals;
}

function resetAt(window: ServerProviderUsageWindow): number | null {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function isLowLimitDismissed(
  dismissals: LowLimitDismissals,
  signal: LowLimitSignal,
): boolean {
  if (!dismissals.has(signal.key)) return false;
  const dismissedResetAt = dismissals.get(signal.key) ?? null;
  // Judged by when the usage was read, not the clock: a later read is what can show a new window.
  return dismissedResetAt === null || Date.parse(signal.checkedAt) < dismissedResetAt;
}

/** Ticks once a minute; the rest of the composer does not re-render with it. */
function LowLimitTiming({ window }: { readonly window: ServerProviderUsageWindow }) {
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00.000Z`);
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge size="lg" variant="warning" tabIndex={0} />}>
        {remainingPercent(window)}% left
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-1">
          <Text variant="meta">{window.label} window</Text>
          {[formatResetsIn(window, now), formatRunsOutIn(window, now)]
            .filter((part) => part !== null)
            .map((part) => (
              <Text key={part} variant="meta">
                {part}
              </Text>
            ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export interface LimitsSource {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}

function LimitsPopover({ source }: { readonly source: LimitsSource }) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>Limits</PopoverTrigger>
      <PopoverPopup
        ref={popupRef}
        initialFocus={popupRef}
        aria-label="Usage limits"
        side="top"
        align="end"
        padding="compact"
        className="w-[min(32rem,calc(100vw-2rem))]"
      >
        <LimitsPopoverReport source={source} />
      </PopoverPopup>
    </Popover>
  );
}

function LimitsPopoverReport({ source }: { readonly source: LimitsSource }) {
  const [openedAt] = useState(Date.now);
  const report = collectProviderUsageLimits(
    source.instanceId,
    source.providers,
    source.sources,
    openedAt,
  );
  return (
    <div className="flex flex-col gap-3">
      <PopoverTitle>Usage limits</PopoverTitle>
      {report ? (
        <UsageLimitsAccounts report={report} environmentId={source.environmentId} />
      ) : (
        <span className="text-meta text-muted-foreground">Usage limits are unavailable</span>
      )}
    </div>
  );
}

/** The notice for a session under a quarter left, with a way over to another provider. */
export function lowLimitBannerItem({
  signal,
  switchTarget,
  onSwitch,
  limits,
  onDismissed,
}: {
  readonly signal: LowLimitSignal;
  readonly switchTarget: ServerProvider | null;
  readonly onSwitch: (provider: ServerProvider) => void;
  readonly limits: LimitsSource | null;
  readonly onDismissed: (dismissals: LowLimitDismissals) => void;
}): ComposerBannerStackItem {
  return {
    id: `low-limit:${signal.key}`,
    variant: "warning",
    icon: <GaugeIcon />,
    title: (
      <span className="inline-flex items-center gap-2">
        <Text variant="meta">{providerName(signal.driver)} usage low</Text>
        <LowLimitTiming window={signal.window} />
      </span>
    ),
    actions: (
      <>
        {limits ? <LimitsPopover source={limits} /> : null}
        {switchTarget ? (
          <Button size="xs" variant="secondary" onClick={() => onSwitch(switchTarget)}>
            Switch to {providerName(switchTarget.driver, switchTarget.displayName)}
          </Button>
        ) : null}
      </>
    ),
    dismissLabel: "Dismiss low usage notice",
    onDismiss: () => {
      sessionLowLimitDismissals = new Map(sessionLowLimitDismissals).set(
        signal.key,
        resetAt(signal.window),
      );
      onDismissed(sessionLowLimitDismissals);
    },
  };
}
