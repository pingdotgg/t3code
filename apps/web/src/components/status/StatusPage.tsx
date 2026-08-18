import { useAtomValue } from "@effect/atom-react";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerProvider } from "@t3tools/contracts";
import { ExternalLinkIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  codexRateLimitWindowLabel,
  codexRemainingPercent,
  formatStatusTimestampWithTimeZone,
} from "./StatusPage.logic";

const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";
const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage?from=cc_cli_limit_message";

function formatResetTimestamp(timestamp: number | null | undefined): string | null {
  if (timestamp == null) return null;
  return formatStatusTimestampWithTimeZone(new Date(timestamp * 1000).toISOString());
}

function StatusEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty className="min-h-64 rounded-xl border border-dashed border-border/70 bg-card/20 p-8">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheckIcon />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function RateLimitRow({
  label,
  valuePercent,
  resetTimestamp,
  kind = "remaining",
}: {
  readonly label: string;
  readonly valuePercent: number;
  readonly resetTimestamp: string | null;
  readonly kind?: "remaining" | "used";
}) {
  const percent = Math.max(0, Math.min(100, valuePercent));
  const suffix = kind === "remaining" ? "% left" : "% used";

  return (
    <div className="rounded-lg border border-border/60 bg-background/35 px-3 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">
          {percent}
          {suffix}
        </span>
      </div>
      <div
        aria-label={`${label}: ${percent}${suffix}`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      {resetTimestamp ? (
        <p className="mt-2 text-[11px] text-muted-foreground">Resets {resetTimestamp}</p>
      ) : null}
    </div>
  );
}

function CodexRateLimitsCard({
  provider,
  showProviderLabel,
}: {
  readonly provider: ServerProvider;
  readonly showProviderLabel: boolean;
}) {
  const rateLimits = provider.codexStatus?.rateLimits;

  return (
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none before:rounded-[calc(var(--radius-xl)-1px)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {showProviderLabel ? (
            <h2 className="text-sm font-medium text-foreground">
              {provider.displayName ?? "Codex"}
            </h2>
          ) : null}
        </div>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          Updated {formatStatusTimestampWithTimeZone(provider.checkedAt)}
        </span>
      </div>

      {rateLimits?.primary || rateLimits?.secondary ? (
        <div className="mt-4 flex flex-col gap-2">
          {rateLimits.limitName ? (
            <span className="text-[11px] text-muted-foreground">{rateLimits.limitName}</span>
          ) : null}
          {rateLimits.primary ? (
            <RateLimitRow
              label={
                codexRateLimitWindowLabel(rateLimits.primary.windowDurationMins) === "Rate limit"
                  ? "Primary limit"
                  : codexRateLimitWindowLabel(rateLimits.primary.windowDurationMins)
              }
              valuePercent={codexRemainingPercent(rateLimits.primary.usedPercent)}
              resetTimestamp={formatResetTimestamp(rateLimits.primary.resetsAt)}
              kind="remaining"
            />
          ) : null}
          {rateLimits.secondary ? (
            <RateLimitRow
              label={
                codexRateLimitWindowLabel(rateLimits.secondary.windowDurationMins) === "Rate limit"
                  ? "Secondary limit"
                  : codexRateLimitWindowLabel(rateLimits.secondary.windowDurationMins)
              }
              valuePercent={codexRemainingPercent(rateLimits.secondary.usedPercent)}
              resetTimestamp={formatResetTimestamp(rateLimits.secondary.resetsAt)}
              kind="remaining"
            />
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Rate limit data is not available yet. Click Update to try again.
        </p>
      )}
    </Card>
  );
}

function ClaudeRateLimitsCard({
  provider,
  showProviderLabel,
}: {
  readonly provider: ServerProvider;
  readonly showProviderLabel: boolean;
}) {
  const rateLimits = provider.claudeStatus?.rateLimits;

  return (
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none before:rounded-[calc(var(--radius-xl)-1px)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {showProviderLabel ? (
            <h2 className="text-sm font-medium text-foreground">
              {provider.displayName ?? "Claude"}
            </h2>
          ) : null}
        </div>
        <span className="shrink-0 text-right text-xs text-muted-foreground">
          Updated {formatStatusTimestampWithTimeZone(provider.checkedAt)}
        </span>
      </div>

      {rateLimits?.currentSession || rateLimits?.currentWeek ? (
        <div className="mt-4 flex flex-col gap-2">
          {rateLimits.currentSession ? (
            <RateLimitRow
              label="Current session"
              valuePercent={rateLimits.currentSession.usedPercent}
              resetTimestamp={
                rateLimits.currentSession.resetsAt
                  ? formatStatusTimestampWithTimeZone(rateLimits.currentSession.resetsAt)
                  : null
              }
              kind="used"
            />
          ) : null}
          {rateLimits.currentWeek ? (
            <RateLimitRow
              label="Weekly limit"
              valuePercent={rateLimits.currentWeek.usedPercent}
              resetTimestamp={
                rateLimits.currentWeek.resetsAt
                  ? formatStatusTimestampWithTimeZone(rateLimits.currentWeek.resetsAt)
                  : null
              }
              kind="used"
            />
          ) : null}
          {rateLimits.currentWeekPromo ? (
            <p className="text-xs text-muted-foreground">{rateLimits.currentWeekPromo}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Claude rate limit data is not available yet. Click Update to try again.
        </p>
      )}
    </Card>
  );
}

export function StatusPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const codexProviders = useMemo(
    () => providers.filter((provider) => provider.driver === "codex"),
    [providers],
  );
  const claudeProviders = useMemo(
    () => providers.filter((provider) => provider.driver === "claudeAgent"),
    [providers],
  );
  const statusProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
      ),
    [providers],
  );
  const refresh = useCallback(async () => {
    if (!primaryEnvironmentId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const result = await refreshProviders({
        environmentId: primaryEnvironmentId,
        input: {},
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        console.warn("Failed to refresh status providers", {
          operation: "refresh-status-providers",
          environmentId: primaryEnvironmentId,
          ...safeErrorLogAttributes(error),
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not refresh provider status",
            description:
              error instanceof Error
                ? error.message
                : "The provider refresh command could not be completed.",
          }),
        );
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, primaryEnvironmentId, refreshProviders, statusProviders]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron ? (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Status breadcrumb">
              <WorkspaceBreadcrumbItem current>Status</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        ) : (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Status breadcrumb">
              <WorkspaceBreadcrumbItem current>Status</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-lg font-semibold text-foreground">Status</h1>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Account health and usage across your AI providers.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={isRefreshing || statusProviders.length === 0}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
                Update
              </Button>
            </div>

            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-medium text-foreground">Codex</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current rate-limit windows and remaining credits.
                </p>
              </div>
              {codexProviders.length === 0 ? (
                <StatusEmptyState
                  title="Codex is not configured"
                  description="Add or enable the Codex provider in Settings to inspect its rate limits here."
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {codexProviders.map((provider) => (
                    <CodexRateLimitsCard
                      key={provider.instanceId}
                      provider={provider}
                      showProviderLabel={codexProviders.length > 1}
                    />
                  ))}
                </div>
              )}

              <a
                className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                href={CODEX_USAGE_URL}
                rel="noreferrer"
                target="_blank"
              >
                View up-to-date rate limits and credits
                <ExternalLinkIcon className="size-3" />
              </a>
            </section>

            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-medium text-foreground">Claude</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current usage windows and percentage used.
                </p>
              </div>
              {claudeProviders.length === 0 ? (
                <StatusEmptyState
                  title="Claude is not configured"
                  description="Add or enable the Claude provider in Settings to inspect its usage here."
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {claudeProviders.map((provider) => (
                    <ClaudeRateLimitsCard
                      key={provider.instanceId}
                      provider={provider}
                      showProviderLabel={claudeProviders.length > 1}
                    />
                  ))}
                </div>
              )}

              <a
                className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                href={CLAUDE_USAGE_URL}
                rel="noreferrer"
                target="_blank"
              >
                View up-to-date usage and rate limits
                <ExternalLinkIcon className="size-3" />
              </a>
            </section>
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
