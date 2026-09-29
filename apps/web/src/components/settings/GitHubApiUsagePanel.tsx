import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  type GitHubApiQuotaBucket,
  type GitHubApiUsageBreakdown,
  type GitHubApiUsageWindow,
} from "@t3tools/contracts";
import { ActivityIcon, AlertTriangleIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  gitHubApiQuotaRefreshMutationOptions,
  gitHubApiUsageReportQueryOptions,
} from "../../lib/pullRequestReactQuery";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const WINDOWS: ReadonlyArray<{ value: GitHubApiUsageWindow; label: string }> = [
  { value: "5m", label: "5 min" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
];

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatLatency(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function formatCountdown(targetIso: string | null, nowMs: number): string | null {
  if (targetIso === null) return null;
  const diff = Date.parse(targetIso) - nowMs;
  if (!Number.isFinite(diff)) return null;
  if (diff <= 0) return "reset due";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "resets in under a minute";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `resets in ${hours}h ${minutes % 60}m`;
}

/** Split a `host/owner/name#number` breakdown key into a report filter. */
function parsePrKey(key: string): { repository: string; prNumber: number } | null {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return null;
  const prNumber = Number(key.slice(hash + 1));
  const repoKey = key.slice(0, hash);
  const slash = repoKey.indexOf("/");
  const repository = slash < 0 ? repoKey : repoKey.slice(slash + 1);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || repository.length === 0) return null;
  return { repository, prNumber };
}

function BreakdownRows({
  rows,
  limit = 8,
}: {
  rows: ReadonlyArray<GitHubApiUsageBreakdown>;
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  if (shown.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Nothing in this window.</p>;
  }
  const max = Math.max(...shown.map((row) => row.httpRequests), 1);
  return (
    <ul className="divide-y divide-border/60">
      {shown.map((row) => (
        <li key={row.key} className="flex items-center gap-3 px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-foreground">{row.key}</p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/40"
                style={{ width: `${Math.max(2, Math.round((row.httpRequests / max) * 100))}%` }}
              />
            </div>
          </div>
          <div className="shrink-0 text-right text-[11px] leading-tight text-muted-foreground">
            <span className="font-medium text-foreground">{formatCount(row.httpRequests)}</span> req
            {" · "}
            {formatCount(row.invocations)} calls
            {row.cacheHits > 0 ? (
              <span>
                {" · "}
                {formatCount(row.cacheHits)} cached
              </span>
            ) : null}
            {row.errors > 0 ? (
              <span className="text-destructive">
                {" · "}
                {formatCount(row.errors)} err
              </span>
            ) : null}
            {row.rateLimited > 0 ? (
              <span className="text-destructive">
                {" · "}
                {formatCount(row.rateLimited)} limited
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function QuotaCard({
  bucket,
  onRefresh,
  refreshing,
}: {
  bucket: GitHubApiQuotaBucket;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const nowMs = useRelativeTimeTick(5_000);
  const unknown = bucket.limit === null && bucket.remaining === null && bucket.used === null;
  const stale = !unknown && Date.parse(bucket.lastObservedAt) < nowMs - 10 * 60_000;
  const countdown = formatCountdown(bucket.resetAt, nowMs);
  const coolingDown =
    bucket.coolingDownUntil !== null && Date.parse(bucket.coolingDownUntil) > nowMs;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-xs font-medium text-foreground">
          {bucket.host} · {bucket.resource}
          {bucket.login ? <span className="text-muted-foreground"> · {bucket.login}</span> : null}
        </p>
        <Button
          size="xs"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={`Refresh quota for ${bucket.host}`}
        >
          <RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} />
          Refresh
        </Button>
      </div>
      {unknown ? (
        <p className="text-xs text-muted-foreground">
          No quota headers observed yet — unknown, not zero. Open a pull-request page or refresh to
          observe this host.
        </p>
      ) : (
        <p className="text-xs text-foreground">
          <span className="font-semibold">
            {bucket.remaining !== null ? formatCount(bucket.remaining) : "?"}
          </span>
          <span className="text-muted-foreground">
            {" "}
            remaining of {bucket.limit !== null ? formatCount(bucket.limit) : "?"} used
            {" · "}
            {bucket.used !== null ? formatCount(bucket.used) : "?"}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {coolingDown && bucket.coolingDownKind === "secondary" ? (
          <Badge variant="destructive">secondary limit</Badge>
        ) : null}
        {coolingDown && bucket.coolingDownKind !== "secondary" ? (
          <Badge variant="destructive">cooling down</Badge>
        ) : null}
        {stale && !coolingDown ? <Badge variant="secondary">stale</Badge> : null}
        {countdown ? <span>{countdown}</span> : null}
        <span>
          observed {new Date(bucket.lastObservedAt).toLocaleTimeString("en-US", { hour12: false })}
        </span>
      </div>
    </div>
  );
}

export function GitHubApiUsagePanel() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const [window, setWindow] = useState<GitHubApiUsageWindow>("1h");
  const [host, setHost] = useState<string>("");
  const [feature, setFeature] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [prKey, setPrKey] = useState<string>("");
  const [recentLimit, setRecentLimit] = useState(15);

  const prFilter = useMemo(() => (prKey ? (parsePrKey(prKey) ?? null) : null), [prKey]);
  const request = useMemo(
    () => ({
      window,
      ...(host ? { host } : {}),
      ...(feature ? { feature } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      // A selected pull request scopes by repository plus number, since PR
      // numbers alone collide across repositories.
      ...(prFilter ? { query: prFilter.repository, prNumber: prFilter.prNumber } : {}),
    }),
    [window, host, feature, query, prFilter],
  );
  const reportQuery = useQuery(gitHubApiUsageReportQueryOptions({ environmentId, request }));
  const refreshMutation = useMutation(
    gitHubApiQuotaRefreshMutationOptions({ environmentId, queryClient }),
  );

  const report = reportQuery.data;
  const refreshError =
    refreshMutation.error instanceof Error
      ? refreshMutation.error.message
      : refreshMutation.error
        ? String(refreshMutation.error)
        : null;
  const hostOptions = useMemo(
    () => [...new Set((report?.byHost ?? []).map((row) => row.key))].toSorted(),
    [report],
  );
  const featureOptions = useMemo(
    () => [...new Set((report?.byFeature ?? []).map((row) => row.key))].toSorted(),
    [report],
  );
  const prOptions = useMemo(() => (report?.byPullRequest ?? []).map((row) => row.key), [report]);
  const trendMax = Math.max(1, ...(report?.trend ?? []).map((bucket) => bucket.httpRequests));
  const visibleRecent = (report?.recent ?? []).slice(0, recentLimit);

  // A selected PR that aged out of the window stops filtering rather than
  // silently narrowing to nothing.
  useEffect(() => {
    if (report && prKey !== "" && !prOptions.includes(prKey)) {
      setPrKey("");
      setRecentLimit(15);
    }
  }, [report, prKey, prOptions]);

  return (
    <SettingsSection
      title="GitHub API usage"
      icon={<GaugeIcon className="size-3.5" />}
      description="Rolling request counts for this server's own GitHub calls, plus the shared quota they spend."
      headerAction={
        <Button
          size="xs"
          variant="outline"
          onClick={() => void reportQuery.refetch()}
          disabled={reportQuery.isFetching}
        >
          <RefreshCwIcon className={reportQuery.isFetching ? "size-3 animate-spin" : "size-3"} />
          Reload
        </Button>
      }
    >
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex overflow-hidden rounded-lg border border-border/60"
            role="group"
            aria-label="Time window"
          >
            {WINDOWS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setWindow(option.value)}
                aria-pressed={window === option.value}
                className={
                  window === option.value
                    ? "bg-foreground px-3 py-1.5 text-xs font-medium text-background"
                    : "px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <select
            aria-label="Filter by host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            className="h-8 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground"
          >
            <option value="">All hosts</option>
            {hostOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by caller"
            value={feature}
            onChange={(event) => setFeature(event.target.value)}
            className="h-8 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground"
          >
            <option value="">All callers</option>
            {featureOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by pull request"
            value={prKey}
            onChange={(event) => {
              setPrKey(event.target.value);
              setRecentLimit(15);
            }}
            className="h-8 max-w-56 rounded-lg border border-border/60 bg-background px-2 text-xs text-foreground"
          >
            <option value="">All pull requests</option>
            {prOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter operation or repo…"
            aria-label="Filter by operation or repository"
            className="h-8 w-48"
          />
        </div>
        {refreshError ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-foreground"
          >
            <span className="font-medium">Quota refresh failed: </span>
            {refreshError}{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => refreshMutation.reset()}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {reportQuery.isPending ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading usage…
          </div>
        ) : reportQuery.error || !report ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <AlertTriangleIcon className="size-6 text-destructive" />
              </EmptyMedia>
              <EmptyTitle>Could not load usage</EmptyTitle>
              <EmptyDescription>
                {reportQuery.error instanceof Error
                  ? reportQuery.error.message
                  : "Please try again."}
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" variant="outline" onClick={() => void reportQuery.refetch()}>
              Retry
            </Button>
          </Empty>
        ) : report.totals.invocations === 0 && report.totals.servedFromCache === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <ActivityIcon className="size-6 text-muted-foreground" />
              </EmptyMedia>
              <EmptyTitle>No GitHub calls observed yet</EmptyTitle>
              <EmptyDescription>
                Open the pull-request list or detail once and return here — every call this server
                makes through the GitHub CLI is counted, newest first.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {!report.coverage.complete ? (
              <div className="rounded-xl border border-border/60 bg-muted/50 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                Partial window coverage — counts cover{" "}
                {new Date(report.coverage.startAt).toLocaleString("en-US")} onward. Older traffic
                predates this server run or fell out of the bounded history.
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                {
                  label: "HTTP requests",
                  value: `${formatCount(report.totals.httpRequests)}${report.totals.httpRequestsUnknown ? "+" : ""}`,
                  hint: report.totals.httpRequestsUnknown ? "some calls untraced" : "measured",
                },
                {
                  label: "CLI calls",
                  value: formatCount(report.totals.invocations),
                  hint: "gh invocations",
                },
                {
                  label: "Cache-served",
                  value: formatCount(report.totals.servedFromCache),
                  hint: "no traffic",
                },
                { label: "Errors", value: formatCount(report.totals.errors), hint: "failed calls" },
                {
                  label: "Rate-limited",
                  value: formatCount(report.totals.rateLimited),
                  hint: "refused calls",
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-xl border border-border/60 px-3 py-2.5 text-center"
                >
                  <p className="text-lg font-semibold tabular-nums text-foreground">{stat.value}</p>
                  <p className="text-[11px] font-medium text-foreground/70">{stat.label}</p>
                  <p className="text-[10px] text-muted-foreground">{stat.hint}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Trend
              </p>
              <div
                className="flex h-16 items-end gap-0.5 rounded-xl border border-border/60 px-3 py-2"
                role="img"
                aria-label={`Request trend: ${formatCount(report.totals.httpRequests)} measured requests in the last ${window}`}
              >
                {report.trend.map((bucket) => (
                  <div
                    key={bucket.at}
                    title={`${new Date(bucket.at).toLocaleTimeString("en-US", { hour12: false })} — ${bucket.httpRequests} requests, ${bucket.invocations} calls`}
                    className="min-w-1 flex-1 rounded-sm bg-foreground/40"
                    style={{
                      height: `${Math.max(4, Math.round((bucket.httpRequests / trendMax) * 100))}%`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Biggest callers
              </p>
              <BreakdownRows rows={report.byFeature} />
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                By operation
              </p>
              <BreakdownRows rows={report.byOperation} />
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                By repository
              </p>
              <BreakdownRows rows={report.byRepository} />
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                By pull request
              </p>
              <BreakdownRows rows={report.byPullRequest} />
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Quota
              </p>
              <div className="flex flex-col gap-2">
                {report.quota.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    No quota observed yet — quota arrives passively with API responses.
                  </p>
                ) : (
                  report.quota.map((bucket) => (
                    <QuotaCard
                      key={`${bucket.host} ${bucket.resource} ${bucket.login ?? ""}`}
                      bucket={bucket}
                      refreshing={refreshMutation.isPending}
                      onRefresh={() =>
                        refreshMutation.mutate({
                          host: bucket.host === "unknown" ? "github.com" : bucket.host,
                        })
                      }
                    />
                  ))
                )}
              </div>
            </div>

            <div>
              <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Recent calls
              </p>
              <ul className="divide-y divide-border/60">
                {visibleRecent.map((event) => (
                  <li
                    key={`${event.at}|${event.operation}|${event.feature}|${event.host}|${event.repository ?? ""}|${event.prNumber ?? ""}|${event.outcome}|${event.httpRequests ?? "?"}`}
                    className="flex items-center gap-3 px-1 py-1.5 text-xs"
                  >
                    <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                      {new Date(event.at).toLocaleTimeString("en-US", { hour12: false })}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {event.operation}
                      <span className="text-muted-foreground"> · {event.feature}</span>
                      {event.repository ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {event.repository}
                          {event.prNumber ? `#${event.prNumber}` : ""}
                        </span>
                      ) : null}
                      {event.servedFromCache ? (
                        <span className="text-muted-foreground"> · cache</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {event.httpRequests === null ? "? req" : `${event.httpRequests} req`}
                      {" · "}
                      {formatLatency(event.latencyMs)}
                    </span>
                    <span
                      className={
                        event.outcome === "success"
                          ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                          : "shrink-0 text-destructive"
                      }
                    >
                      {event.outcome === "success"
                        ? "ok"
                        : event.outcome === "rate-limited"
                          ? "limited"
                          : "error"}
                    </span>
                  </li>
                ))}
              </ul>
              {visibleRecent.length === 0 ? (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  No calls match these filters in this window.
                </p>
              ) : (
                <p className="px-1 pt-2 text-[11px] text-muted-foreground">
                  Showing {visibleRecent.length} of {report.recent.length} recent calls
                  {visibleRecent.length < report.recent.length ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() =>
                          setRecentLimit((limit) => Math.min(limit + 15, report.recent.length))
                        }
                      >
                        Show more
                      </button>
                    </>
                  ) : null}
                </p>
              )}
            </div>

            <div className="rounded-xl bg-muted/50 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
              <p>
                Counts cover only GitHub traffic this server made through its own GitHub CLI calls —
                terminal commands, other checkouts, CI, and other apps on the same account spend the
                same quota and are not shown. That is why the remaining quota can be lower than this
                server&apos;s counts suggest.
              </p>
              <p className="mt-1">
                Request counts are measured per HTTP request from the CLI&apos;s own trace; a “?”
                means that call&apos;s trace was unavailable and was never guessed. Headline totals
                persist across restarts in durable per-minute buckets; recent-call detail and
                filtered drilldowns read the bounded in-memory list. Quota is read passively from
                response headers; Refresh spends one request and is throttled to one attempt per
                host every 5 minutes.
              </p>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
