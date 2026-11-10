import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { collectLimitAccounts, limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";
import { summarizeTodayUsage } from "@t3tools/shared/usageToday";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
  UsageBucket,
  UsageProviderKind,
} from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import { useRef, useState, type ReactNode } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { InfoIcon } from "lucide-react";

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

type DriverAccount = DriverLimits["accounts"][number];

type DriverGroup = {
  readonly driver: ProviderDriverKind;
  readonly kind: UsageProviderKind;
  readonly accounts: Map<string, DriverAccount>;
};

function selectedDriverLimits(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
): Map<ProviderDriverKind, DriverLimits> {
  const byDriver = new Map<ProviderDriverKind, DriverGroup>();
  const addAccount = (
    driver: ProviderDriverKind,
    kind: UsageProviderKind,
    account: DriverAccount,
  ) => {
    const group = byDriver.get(driver) ?? {
      driver,
      kind,
      accounts: new Map<string, DriverAccount>(),
    };
    const previous = group.accounts.get(account.key);
    if (
      previous === undefined ||
      Date.parse(account.checkedAt) > Date.parse(previous.checkedAt) ||
      (previous.windows.length === 0 && account.windows.length > 0)
    ) {
      group.accounts.set(account.key, account);
    }
    byDriver.set(driver, group);
  };

  for (const account of collectLimitAccounts(presentations)) {
    const kind = (Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[]).find(
      (candidate) => PROVIDER_PRESENTATION[candidate].driverKind === account.driver,
    );
    if (kind === undefined) continue;
    addAccount(account.driver, kind, {
      key: account.key,
      label:
        account.email?.trim() || account.displayName?.trim() || account.sourceLabel || "Account",
      windows: [...account.limits.windows],
      notice: null,
      noticeDetails: null,
      checkedAt: account.limits.checkedAt,
      accentColor: account.accentColor,
    });
  }

  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const limits = provider.usageLimits;
      if (
        !provider.enabled ||
        !provider.installed ||
        !isProviderAvailable(provider) ||
        limits === undefined
      ) {
        continue;
      }
      const kind = (Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[]).find(
        (candidate) => PROVIDER_PRESENTATION[candidate].driverKind === provider.driver,
      );
      if (kind === undefined) continue;
      const notice = limitsNotice(limits);
      if (notice === null) continue;
      const accountIdentity =
        provider.auth.email?.trim().toLowerCase() || `${environmentId}:${provider.instanceId}`;
      addAccount(provider.driver, kind, {
        key: [accountIdentity, provider.auth.workspaceId ?? ""].join(":"),
        label:
          provider.auth.email?.trim() ||
          provider.displayName?.trim() ||
          presentation.entry.target.label,
        windows: [],
        notice:
          limits.unavailable?.reason === "probeFailed"
            ? "Could not load subscription limits. Refresh to try again."
            : notice,
        noticeDetails:
          limits.unavailable?.reason === "probeFailed"
            ? (limits.unavailable.message ?? null)
            : null,
        checkedAt: limits.checkedAt,
        accentColor: provider.accentColor,
      });
    }
  }
  return new Map(
    [...byDriver].map(([driver, group]) => [
      driver,
      { ...group, accounts: [...group.accounts.values()] },
    ]),
  );
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
      : `updated ${new Date(latestCheckedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;

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
        setNow(Date.now());
        if (!AsyncResult.isSuccess(result)) {
          console.error("[quick-usage] Provider limit refresh failed", result.cause);
          toastManager.add({
            type: "error",
            title: "Could not refresh usage limits",
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
              title: "Could not refresh usage limits",
              description: `Refresh failed for ${failures.map(({ label }) => label).join(", ")}.`,
            });
          }
        }
        await usage.refresh(todayWindow);
      })
      .catch((error: unknown) => {
        console.error("[quick-usage] Refresh failed", error);
        toastManager.add({
          type: "error",
          title: "Could not refresh usage",
          description: error instanceof Error ? error.message : "Try again.",
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
        render={<Button ref={triggerRef} variant="ghost" size="sm" aria-label="Usage" />}
      >
        {trigger ?? "Usage"}
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
            <PopoverTitle>Quick usage</PopoverTitle>
            <span className="ms-auto text-xs text-muted-foreground tabular-nums">
              {updated ?? ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh usage"
              aria-busy={isRefreshing}
              disabled={isRefreshing}
              onClick={refresh}
            >
              <RefreshIcon size="xs" refreshing={isRefreshing} />
            </Button>
          </div>

          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage limits reported yet.</p>
          ) : (
            <>
              <div className="min-w-0 max-w-full overflow-x-auto">
                <ToggleGroup
                  aria-label="Usage provider"
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

              <div aria-label="Usage windows" className="flex flex-col gap-3">
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
                          {account.notice ?? "No usage limits reported yet."}
                        </p>
                        {account.noticeDetails ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Subscription limit error details for ${account.label}`}
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

          {todaySummary ? (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-foreground/5 px-3 py-2">
              <div className="min-w-0 text-xs tabular-nums">
                <p className="font-medium text-foreground">Spent today</p>
                <p className="truncate text-muted-foreground">
                  {formatUsd(todaySummary.todayCostUsd)} spent · {formatUsd(todaySummary.paceUsd)}{" "}
                  pace
                </p>
              </div>
              {todaySummary.deltaPercent === null ? null : (
                <span className="shrink-0 rounded-full border border-border px-2 py-1 text-2xs font-medium tabular-nums text-muted-foreground">
                  {Math.abs(Math.round(todaySummary.deltaPercent))}%{" "}
                  {todaySummary.deltaPercent <= 0 ? "under" : "over"} pace
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
              View more
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
