import { useAtomValue } from "@effect/atom-react";
import type {
  ServerProvider,
  ServerProviderClaudeRateLimitWindow,
  ServerProviderCodexRateLimitWindow,
} from "@t3tools/contracts";
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
import {
  codexRateLimitWindowLabel,
  codexRemainingPercent,
  formatClaudeResetTimestamp,
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
  window,
  fallbackLabel,
}: {
  readonly window: ServerProviderCodexRateLimitWindow;
  readonly fallbackLabel: string;
}) {
  const remaining = codexRemainingPercent(window.usedPercent);
  const reset = formatResetTimestamp(window.resetsAt);
  const durationLabel = codexRateLimitWindowLabel(window.windowDurationMins);
  const label = durationLabel === "Rate limit" ? fallbackLabel : durationLabel;

  return (
    <div className="rounded-lg border border-border/60 bg-background/35 px-3 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{remaining}% left</span>
      </div>
      <div
        aria-label={`${label}: ${remaining}% left`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={remaining}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${remaining}%` }}
        />
      </div>
      {reset ? <p className="mt-2 text-[11px] text-muted-foreground">Resets {reset}</p> : null}
    </div>
  );
}

function ClaudeRateLimitRow({
  label,
  window,
}: {
  readonly label: string;
  readonly window: ServerProviderClaudeRateLimitWindow;
}) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const reset = window.resetsAt
    ? formatClaudeResetTimestamp(window.resetsAt, label === "Weekly limit")
    : null;

  return (
    <div className="rounded-lg border border-border/60 bg-background/35 px-3 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{used}% used</span>
      </div>
      <div
        aria-label={`${label}: ${used}% used`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={used}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${used}%` }}
        />
      </div>
      {reset ? <p className="mt-2 text-[11px] text-muted-foreground">Resets {reset}</p> : null}
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
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none">
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
            <RateLimitRow window={rateLimits.primary} fallbackLabel="Primary limit" />
          ) : null}
          {rateLimits.secondary ? (
            <RateLimitRow window={rateLimits.secondary} fallbackLabel="Secondary limit" />
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
    <Card className="gap-0 rounded-xl border-border/70 bg-card/35 p-4 shadow-none">
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
            <ClaudeRateLimitRow label="Current session" window={rateLimits.currentSession} />
          ) : null}
          {rateLimits.currentWeek ? (
            <ClaudeRateLimitRow label="Weekly limit" window={rateLimits.currentWeek} />
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
      await Promise.all(
        statusProviders.map((provider) =>
          refreshProviders({
            environmentId: primaryEnvironmentId,
            input: { instanceId: provider.instanceId },
          }),
        ),
      );
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
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear sm:px-5",
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
              "drag-region flex h-[52px] shrink-0 items-center px-5 transition-[padding-left] duration-200 ease-linear wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="Status breadcrumb">
              <WorkspaceBreadcrumbItem current>Status</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
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
                  Current rate-limit windows and remaining credits.
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
                View up-to-date rate limits and credits
                <ExternalLinkIcon className="size-3" />
              </a>
            </section>
          </main>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
