import { AlertTriangleIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";
import type { VibeProxyUsageAccount } from "@t3tools/contracts";
import {
  describeMissingConfiguration,
  formatQuotaPercent,
  formatQuotaReset,
  formatSnapshotAge,
  formatSuccessRate,
  groupVibeProxyAccounts,
  resolveVibeProxyUsageStage,
  vibeProxyAccountName,
  vibeProxyAccountStatus,
  vibeProxyAccountSubtitle,
  vibeProxyQuotaSummary,
  vibeProxyRecentActivity,
  vibeProxyRequestHealth,
  type VibeProxyAccountTone,
  type VibeProxyQuotaState,
  type VibeProxyQuotaWindowView,
} from "@t3tools/shared/vibeProxyUsage";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useAnimatedNumber } from "~/hooks/useAnimatedNumber";
import { cn } from "~/lib/utils";
import { useVibeProxyUsage } from "~/state/vibeProxyUsage";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { VibeProxyProviderMark } from "./VibeProxyProviderMark";

const TONE_TEXT_CLASS: Readonly<Record<VibeProxyAccountTone, string>> = {
  ok: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  muted: "text-muted-foreground",
};

const TONE_DOT_CLASS: Readonly<Record<VibeProxyAccountTone, string>> = {
  ok: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  muted: "bg-muted-foreground/50",
};

const QUOTA_FILL_CLASS: Readonly<Record<VibeProxyQuotaState, string>> = {
  ok: "bg-success",
  low: "bg-warning",
  critical: "bg-error",
  exhausted: "bg-error",
  unknown: "bg-muted-foreground/30",
};

/**
 * Quota bar whose fill tweens to the freshest remaining share.
 *
 * The tween runs only while a value is moving; an idle page holds a static
 * element with no running animation.
 */
function QuotaBar({ window }: { readonly window: VibeProxyQuotaWindowView }) {
  const remaining = useAnimatedNumber(window.remainingFraction ?? 0);
  const percentLabel =
    window.remainingPercent === null ? "Unknown" : formatQuotaPercent(window.remainingPercent);

  return (
    <div
      className="min-w-0 space-y-1"
      role="meter"
      aria-label={`${window.label} remaining`}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(window.remainingPercent === null
        ? { "aria-valuetext": "Unknown" }
        : { "aria-valuenow": Math.round(window.remainingPercent) })}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs font-medium text-foreground">{window.label}</span>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            window.state === "unknown" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {percentLabel}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", QUOTA_FILL_CLASS[window.state])}
          style={{ width: `${Math.round(remaining * 1000) / 10}%` }}
        />
      </div>
    </div>
  );
}

/** Success/failure counts across the reported buckets, oldest to newest. */
function RecentActivityStrip({ account }: { readonly account: VibeProxyUsageAccount }) {
  const activity = useMemo(() => vibeProxyRecentActivity(account), [account]);
  if (activity.buckets.length === 0) return null;

  return (
    <div className="flex items-end gap-px" aria-hidden>
      {activity.buckets.map((bucket) => {
        const total = bucket.success + bucket.failed;
        const height = total === 0 ? 2 : Math.max(3, (total / activity.peak) * 16);
        return (
          <Tooltip key={bucket.key}>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "w-1 shrink-0 rounded-[1px]",
                    total === 0
                      ? "bg-muted"
                      : bucket.failed === 0
                        ? "bg-success/70"
                        : bucket.success === 0
                          ? "bg-error/70"
                          : "bg-warning/70",
                  )}
                  style={{ height: `${height}px` }}
                />
              }
            />
            <TooltipPopup side="top">
              {`${bucket.time}: ${bucket.success} ok, ${bucket.failed} failed`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function AccountRow({
  account,
  nowMs,
}: {
  readonly account: VibeProxyUsageAccount;
  readonly nowMs: number;
}) {
  const status = vibeProxyAccountStatus(account);
  const health = vibeProxyRequestHealth(account);
  const quota = vibeProxyQuotaSummary(account);
  const subtitle = vibeProxyAccountSubtitle(account);
  const plan = account.planType?.trim() || account.accountType?.trim() || null;

  return (
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:gap-8 sm:px-4">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[status.tone])} />
          <span className="truncate text-sm font-medium text-foreground">
            {vibeProxyAccountName(account)}
          </span>
          {account.selected ? (
            <span className="shrink-0 text-[11px] font-medium text-success-foreground">In use</span>
          ) : null}
          {plan ? <span className="shrink-0 text-[11px] text-muted-foreground">{plan}</span> : null}
        </div>
        {subtitle ? <p className="truncate text-xs text-muted-foreground/80">{subtitle}</p> : null}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className={TONE_TEXT_CLASS[status.tone]}>{status.label}</span>
          <span aria-hidden>·</span>
          <span className={health.tone === "ok" ? undefined : TONE_TEXT_CLASS[health.tone]}>
            {formatSuccessRate(health.successRate)}
            {health.total > 0 ? ` of ${health.total.toLocaleString()}` : ""}
          </span>
          {health.failed > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-error-foreground">{health.failed.toLocaleString()} failed</span>
            </>
          ) : null}
        </p>
        {status.detail ? (
          <p className="text-[11px] leading-snug text-muted-foreground/80">{status.detail}</p>
        ) : null}
        <RecentActivityStrip account={account} />
      </div>

      <div className="min-w-0">
        {quota.kind === "windows" ? (
          <div className="space-y-2.5">
            {quota.windows.map((window) => {
              const reset = formatQuotaReset(window.resetAt, nowMs);
              return (
                <div key={window.id} className="min-w-0 space-y-1">
                  <QuotaBar window={window} />
                  {reset || window.routing ? (
                    <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      {reset ? <span>{reset}</span> : null}
                      {window.routing ? <span>Routing</span> : null}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{quota.message}</p>
        )}
      </div>
    </div>
  );
}

function AccountsSkeleton() {
  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:gap-8"
        >
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StateNotice({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "warning";
  readonly children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 px-3 py-3 text-xs sm:px-4",
        tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      {tone === "warning" ? <AlertTriangleIcon className="mt-px size-3.5 shrink-0" /> : null}
      <span>{children}</span>
    </p>
  );
}

export function UsagesSettingsPanel() {
  const vibeProxy = usePrimarySettings((settings) => settings.vibeProxy);
  const updateSettings = useUpdatePrimarySettings();
  const nowMs = useRelativeTimeTick(30_000);

  const hasCredentials =
    vibeProxy.baseUrl.trim().length > 0 &&
    (vibeProxy.apiKey.trim().length > 0 || vibeProxy.apiKeyRedacted);
  const usageConfigurationKey =
    vibeProxy.enabled && hasCredentials
      ? `${vibeProxy.baseUrl.trim()}:${vibeProxy.apiKeyRedacted ? "stored" : vibeProxy.apiKey.length}`
      : null;
  const usage = useVibeProxyUsage(usageConfigurationKey);

  const stage = resolveVibeProxyUsageStage({
    settings: vibeProxy,
    result: usage.result,
    isRefreshing: usage.isRefreshing,
    transportError: usage.error,
  });
  const groups = useMemo(
    () => (stage.kind === "accounts" ? groupVibeProxyAccounts(stage.accounts) : []),
    [stage],
  );

  const snapshotAge = stage.kind === "accounts" ? formatSnapshotAge(stage.fetchedAt, nowMs) : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Vibe-Proxy" icon={<GaugeIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("vibe-proxy-enabled")}
          description="Read account quotas and request health from a Vibe-Proxy instance."
          control={
            <Switch
              checked={vibeProxy.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ vibeProxy: { enabled: Boolean(checked) } })
              }
              aria-label="Enable Vibe-Proxy usage"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("vibe-proxy-base-url")}
          control={
            <DraftInput
              className="w-full sm:w-80"
              value={vibeProxy.baseUrl}
              onCommit={(baseUrl) => updateSettings({ vibeProxy: { baseUrl: baseUrl.trim() } })}
              placeholder="https://vibe-proxy.example.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-label="Vibe-Proxy API base URL"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("vibe-proxy-api-key")}
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <DraftInput
                className="min-w-0 flex-1 sm:w-80"
                value=""
                onCommit={(apiKey) => updateSettings({ vibeProxy: { apiKey: apiKey.trim() } })}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  vibeProxy.apiKeyRedacted
                    ? "Stored key - enter a new value to replace"
                    : "Management API key"
                }
                aria-label="Vibe-Proxy API key"
              />
              {vibeProxy.apiKeyRedacted ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => updateSettings({ vibeProxy: { apiKey: "" } })}
                >
                  Remove key
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Accounts"
        headerAction={
          <div className="flex items-center gap-3">
            {snapshotAge ? (
              <span className="text-xs text-muted-foreground">{snapshotAge}</span>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={!vibeProxy.enabled || !hasCredentials || usage.isRefreshing}
              onClick={usage.refresh}
            >
              <RefreshCwIcon className={cn("size-3.5", usage.isRefreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      >
        {stage.kind === "disabled" ? (
          <StateNotice>Turn on Vibe-Proxy to see account quotas here.</StateNotice>
        ) : null}

        {stage.kind === "unconfigured" ? (
          <StateNotice>{describeMissingConfiguration(stage.missing)}</StateNotice>
        ) : null}

        {stage.kind === "loading" ? <AccountsSkeleton /> : null}

        {stage.kind === "empty" ? (
          <StateNotice tone={stage.problem ? "warning" : "muted"}>
            {stage.problem ?? "Vibe-Proxy reported no accounts."}
          </StateNotice>
        ) : null}

        {stage.kind === "accounts" ? (
          <>
            {stage.problem ? (
              <StateNotice tone="warning">
                {stage.problem} Showing the last values Vibe-Proxy reported.
              </StateNotice>
            ) : null}
            {groups.length === 0 ? (
              <StateNotice>Vibe-Proxy reported no accounts.</StateNotice>
            ) : (
              <div
                className={cn(
                  "space-y-5 transition-opacity duration-200 motion-reduce:transition-none",
                  stage.stale && "opacity-70",
                )}
              >
                {groups.map((group) => (
                  <div key={group.key} className="space-y-1">
                    <div className="flex items-center gap-2 px-3 sm:px-4">
                      <VibeProxyProviderMark provider={group.provider} />
                      <h3 className="text-sm font-medium text-foreground">{group.label}</h3>
                      <span className="text-xs text-muted-foreground">{group.accounts.length}</span>
                    </div>
                    <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
                      {group.accounts.map((account) => (
                        <AccountRow key={account.id} account={account} nowMs={nowMs} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
