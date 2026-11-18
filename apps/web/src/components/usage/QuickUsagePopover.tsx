import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { collectLimitAccounts, remainingPercent } from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { summarizeTodayUsage } from "@t3tools/shared/usageToday";
import type { ProviderDriverKind, ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useGT, useMessages } from "gt-react";
import { InfoIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUsage } from "../../state/usage";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LimitWindows } from "./UsageLimits";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

type DriverLimits = {
  readonly driver: ProviderDriverKind;
  readonly kind: UsageProviderKind;
  readonly accounts: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly windows: NonNullable<ServerProvider["usageLimits"]>["windows"];
    readonly notice: string | null;
    readonly noticeDetails: string | null;
    readonly checkedAt: string;
    readonly accentColor: string | undefined;
  }>;
};

function selectedDriverLimits(
  accounts: ReturnType<typeof collectLimitAccounts>,
  gt: ReturnType<typeof useGT>,
  m: ReturnType<typeof useMessages>,
): DriverLimits[] {
  return PROVIDER_ORDER.flatMap((kind) => {
    const driver = PROVIDER_PRESENTATION[kind].driverKind;
    const providerAccounts = accounts.filter((account) => account.driver === driver);
    if (providerAccounts.length === 0) return [];
    return [
      {
        driver,
        kind,
        accounts: providerAccounts.map((account) => {
          const { limits } = account;
          const probeFailed = limits.unavailable?.reason === "probeFailed";
          const notice =
            limits.zeroSpendCap && !limits.unavailable && limits.windows.length === 0
              ? gt("$0 cap")
              : limitsNotice(limits, m);
          return {
            key: account.key,
            label:
              account.email?.trim() ||
              account.displayName?.trim() ||
              account.sourceLabel ||
              account.environments[0]?.label ||
              gt("Account"),
            windows: notice === null ? account.limits.windows : [],
            notice: probeFailed
              ? gt("Could not load subscription limits. Refresh to try again.")
              : notice,
            noticeDetails: probeFailed ? (account.limits.unavailable?.message ?? null) : null,
            checkedAt: account.limits.checkedAt,
            accentColor: account.accentColor,
          };
        }),
      },
    ];
  });
}

export function QuickUsagePopover({
  trigger,
  onOpenFull,
}: {
  readonly trigger?: ReactNode;
  readonly onOpenFull?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<UsageProviderKind | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const appLeftAnchor = () => {
    const trigger = triggerRef.current;
    if (trigger === null) return null;
    return {
      contextElement: trigger,
      getBoundingClientRect: () => {
        const rect = trigger.getBoundingClientRect();
        return new DOMRect(0, rect.top, 1, rect.height);
      },
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A clock subscription keeps the day and reset countdowns current while open.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const todayWindow = makeWindow(8, new Date(now));
  const usage = useUsage(todayWindow);
  const shown = usage.shown;
  const showingToday =
    shown?.window.untilDay === todayWindow.untilDay &&
    shown.window.timeZone === todayWindow.timeZone;
  const todaySummary = showingToday
    ? summarizeTodayUsage(shown.merged.daily, new Date(now), todayWindow.timeZone)
    : null;

  const paceUsd = usage.isPartial ? null : (todaySummary?.paceUsd ?? null);
  const deltaPercent = usage.isPartial ? null : (todaySummary?.deltaPercent ?? null);

  const providers = selectedDriverLimits(
    collectLimitAccounts(presentations, { includeUnavailable: true }),
    gt,
    m,
  );

  let best: DriverLimits | undefined;
  let bestRemaining = Number.POSITIVE_INFINITY;
  for (const provider of providers) {
    const remaining = Math.min(
      ...provider.accounts.flatMap((account) => account.windows.map(remainingPercent)),
    );
    if (remaining < bestRemaining) {
      best = provider;
      bestRemaining = remaining;
    }
  }
  const defaultProvider = best?.kind ?? providers[0]?.kind ?? null;

  const selected =
    (selectedProvider === null
      ? undefined
      : providers.find((provider) => provider.kind === selectedProvider)) ??
    providers.find((provider) => provider.kind === defaultProvider);
  const latestCheckedAt =
    selected?.accounts.reduce<string | null>((latest, account) => {
      if (!account.checkedAt) return latest;
      return latest === null || Date.parse(account.checkedAt) > Date.parse(latest)
        ? account.checkedAt
        : latest;
    }, null) ?? null;
  const updated =
    latestCheckedAt === null || !Number.isFinite(Date.parse(latestCheckedAt))
      ? null
      : gt("updated {time}", {
          time: formatShortTimestamp(latestCheckedAt, timestampFormat),
        });

  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void settlePromise(() =>
      Promise.all(
        Array.from(presentations, async ([environmentId, presentation]) => {
          if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
            return undefined;
          }
          return {
            label: presentation.entry.target.label,
            result: await refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              false,
            ),
          };
        }),
      ),
    )
      .then(async (result) => {
        const refreshedAt = Date.now();
        setNow(refreshedAt);
        if (!AsyncResult.isSuccess(result)) {
          console.error("[quick-usage] Provider limit refresh failed", result.cause);
          toastManager.add({
            type: "error",
            title: gt("Could not refresh usage limits"),
            description: Cause.pretty(result.cause),
          });
        } else {
          const failures = result.value.flatMap((environment) =>
            environment !== undefined &&
            environment.result !== undefined &&
            AsyncResult.isFailure(environment.result)
              ? [{ ...environment, failure: environment.result }]
              : [],
          );
          if (failures.length > 0) {
            toastManager.add({
              type: "error",
              title: gt("Could not refresh usage limits"),
              description: gt("Refresh failed for {environments}.", {
                environments: failures.map(({ label }) => label).join(", "),
              }),
            });
          }
        }
        await usage.refresh(makeWindow(8, new Date(refreshedAt)));
      })
      .catch((error: unknown) => {
        console.error("[quick-usage] Refresh failed", error);
        toastManager.add({
          type: "error",
          title: gt("Could not refresh usage"),
          description: error instanceof Error ? error.message : gt("Try again."),
        });
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setNow(Date.now());
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={<Button ref={triggerRef} variant="ghost" size="sm" aria-label={gt("Usage")} />}
      >
        {trigger ?? gt("Usage")}
      </PopoverTrigger>
      <PopoverPopup
        width="xl"
        side="top"
        align="start"
        sideOffset={8}
        anchor={appLeftAnchor}
        collisionPadding={0}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <PopoverTitle>{gt("Quick usage")}</PopoverTitle>
            <span className="ms-auto text-xs text-muted-foreground tabular-nums">
              {updated ?? ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={gt("Refresh usage")}
              aria-busy={isRefreshing}
              disabled={isRefreshing}
              onClick={refresh}
            >
              <RefreshIcon size="xs" refreshing={isRefreshing} />
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{gt("No usage limits reported yet.")}</p>
          ) : (
            <>
              <div className="min-w-0 max-w-full overflow-x-auto">
                <ToggleGroup
                  aria-label={gt("Usage provider")}
                  variant="segmented"
                  value={selected ? [selected.kind] : []}
                  onValueChange={(next) => {
                    const provider = providers.find(({ kind }) => kind === next[0]);
                    if (provider) setSelectedProvider(provider.kind);
                  }}
                >
                  {providers.map((provider) => (
                    <Toggle key={provider.kind} value={provider.kind}>
                      {PROVIDER_PRESENTATION[provider.kind].label}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>

              <div aria-label={gt("Usage windows")} className="flex flex-col gap-3">
                {selected?.accounts.map((account) => (
                  <section key={account.key} className="flex flex-col gap-1.5">
                    {selected.accounts.length > 1 ? (
                      <p className="truncate text-xs font-medium text-muted-foreground">
                        {account.label}
                      </p>
                    ) : null}
                    {account.windows.length > 0 ? (
                      <LimitWindows
                        driver={selected.driver}
                        accentColor={account.accentColor}
                        barColorOverride="var(--primary)"
                        windows={account.windows}
                        now={now}
                        stacked
                      />
                    ) : (
                      <div className="flex items-start gap-1">
                        <p className="text-sm text-muted-foreground">
                          {account.notice ?? gt("No usage limits reported yet.")}
                        </p>
                        {account.noticeDetails ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={gt("Subscription limit error details for {account}", {
                                    account: account.label,
                                  })}
                                />
                              }
                            >
                              <InfoIcon />
                            </TooltipTrigger>
                            <TooltipPopup>{account.noticeDetails}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </>
          )}

          {!showingToday && usage.isPending ? (
            <p role="status" className="text-xs text-muted-foreground">
              {gt("Loading today’s spending…")}
            </p>
          ) : todaySummary ? (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-foreground/5 px-3 py-2">
              <div className="min-w-0 text-xs tabular-nums">
                <p className="font-medium text-foreground">{gt("Spent today")}</p>
                <p className="truncate text-muted-foreground">
                  {paceUsd === null
                    ? formatUsd(todaySummary.todayCostUsd)
                    : gt("{spent} spent · {pace} pace", {
                        spent: formatUsd(todaySummary.todayCostUsd),
                        pace: formatUsd(paceUsd),
                      })}
                </p>
                {usage.isPartial ? (
                  <p className="text-muted-foreground">
                    {gt("Totals are partial while selected environments scan.")}
                  </p>
                ) : null}
              </div>
              {deltaPercent === null ? null : (
                <span className="shrink-0 rounded-full border border-border px-2 py-1 text-2xs font-medium tabular-nums text-muted-foreground">
                  {deltaPercent <= 0
                    ? gt("{percent}% under pace", {
                        percent: Math.abs(Math.round(deltaPercent)),
                      })
                    : gt("{percent}% over pace", {
                        percent: Math.round(deltaPercent),
                      })}
                </span>
              )}
            </div>
          ) : null}

          {usage.selectedEnvironments.map(({ environmentId, label, error }) =>
            error === null ? null : (
              <p key={environmentId} role="alert" className="text-xs text-destructive">
                {label}: {error}
              </p>
            ),
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onOpenFull?.();
              }}
            >
              {gt("View more")}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
