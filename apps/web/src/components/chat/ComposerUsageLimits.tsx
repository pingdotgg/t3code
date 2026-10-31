import {
  type EnvironmentId,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  collectLimitAccounts,
  formatResetsIn,
  formatRunsOutIn,
  isLowLimit,
  limitsNotice,
  remainingPercent,
  tightestSessionLimit,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? (
        <span className="ms-1.5 font-normal text-dim-foreground">{account.plan}</span>
      ) : null}
    </>
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
    description: `${defaultProviderName} is out of usage${resetsAt ? ` · resets ${formatUpcomingTimestamp(resetsAt, timestampFormat)}` : ""}`,
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
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-3 ps-0 pt-0.5 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-medium text-muted-foreground text-xs">
                <AccountSummary account={account} />
              </span>
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
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
        {report.notices.map((notice) => (
          <span key={notice} className="text-meta text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}

/**
 * The session a low-limit notice watches: the selected instance's own account
 * when it reports, else the tightest account of that driver a hub reports.
 */
export interface LowLimitSignal {
  /** Dismissals last until this window resets. */
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly window: ServerProviderUsageWindow;
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
): LowLimitSignal | null {
  if (!provider) return null;
  const tightest =
    ownSessionLimit(provider) ??
    tightestSessionLimit(
      collectLimitAccounts(
        new Map([
          [
            environmentId,
            {
              entry: { target: { label: "" } },
              serverConfig: { providers, usageLimitSources: sources },
            },
          ],
        ]),
      ),
      provider.driver,
    );
  if (!tightest || !isLowLimit(tightest.window)) return null;
  return {
    key: [
      environmentId,
      provider.instanceId,
      tightest.account.key,
      tightest.window.id,
      tightest.window.resetsAt ?? "",
    ].join("\u0000"),
    driver: provider.driver,
    window: tightest.window,
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

// Session-scoped so a remount does not bring a dismissed notice back before
// its window resets.
const dismissedLowLimitKeys = new Set<string>();

export function isLowLimitDismissed(key: string): boolean {
  return dismissedLowLimitKeys.has(key);
}

/** Ticks once a minute; the rest of the composer does not re-render with it. */
function LowLimitTiming({ window }: { readonly window: ServerProviderUsageWindow }) {
  const minute = useNowMinute();
  const now = Date.parse(`${minute}:00.000Z`);
  return [formatResetsIn(window, now), formatRunsOutIn(window, now)]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The notice for a session under a quarter left, with a way over to another provider. */
export function lowLimitBannerItem({
  signal,
  switchTarget,
  onSwitch,
  onShowLimits,
  onDismissed,
}: {
  readonly signal: LowLimitSignal;
  readonly switchTarget: ServerProvider | null;
  readonly onSwitch: (provider: ServerProvider) => void;
  readonly onShowLimits: (() => void) | null;
  readonly onDismissed: () => void;
}): ComposerBannerStackItem {
  return {
    id: `low-limit:${signal.key}`,
    variant: "warning",
    icon: <GaugeIcon />,
    title: formatLimitSummary(signal.driver, signal.window),
    description: <LowLimitTiming window={signal.window} />,
    actions: (
      <>
        {onShowLimits ? (
          <Button size="xs" variant="ghost" onClick={onShowLimits}>
            Limits
          </Button>
        ) : null}
        {switchTarget ? (
          <Button size="xs" variant="secondary" onClick={() => onSwitch(switchTarget)}>
            Switch to {providerName(switchTarget.driver, switchTarget.displayName)}
          </Button>
        ) : null}
      </>
    ),
    dismissLabel: "Dismiss low usage notice",
    onDismiss: () => {
      dismissedLowLimitKeys.add(signal.key);
      onDismissed();
    },
  };
}
