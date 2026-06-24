import type { EnvironmentId, PullRequestSummary } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  MessageCircleIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo } from "react";

import { gitPrEnvironment } from "~/state/gitPr";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

interface PullRequestListPanelProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  selectedPrNumber: number | null;
  onSelect: (pr: PullRequestSummary) => void;
  onOpenExternal?: (url: string) => void;
}

function relativeTime(value: string): string {
  if (!value) return "";
  const then = Date.parse(value);
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function ChecksBadge({ pr }: { pr: PullRequestSummary }) {
  if (pr.checksTotal === 0) return null;
  const hasFail = pr.checksFailing > 0;
  const allPass = pr.checksFailing === 0 && pr.checksPending === 0;
  const tone = hasFail
    ? "bg-destructive/10 text-destructive border-destructive/30"
    : allPass
      ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/25 dark:text-emerald-300"
      : "bg-amber-500/10 text-amber-600 border-amber-500/25 dark:text-amber-300";
  const Icon = hasFail ? XIcon : allPass ? CheckIcon : CircleDashedIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        tone,
      )}
      title={`${pr.checksPassing} passed · ${pr.checksFailing} failing · ${pr.checksPending} pending`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {pr.checksPassing}/{pr.checksTotal}
    </span>
  );
}

function StatusPill({ pr }: { pr: PullRequestSummary }) {
  if (pr.isDraft) {
    return (
      <span className="inline-flex items-center rounded-full border border-muted-foreground/30 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        Draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
      Open
    </span>
  );
}

const PullRequestCard = memo(function PullRequestCard({
  pr,
  isSelected,
  onSelect,
  onOpenExternal,
}: {
  pr: PullRequestSummary;
  isSelected: boolean;
  onSelect: (pr: PullRequestSummary) => void;
  onOpenExternal?: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(pr)}
      className={cn(
        "group flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors",
        isSelected
          ? "border-primary/40 bg-primary/5"
          : "border-border/70 bg-background hover:border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{pr.title}</span>
        {pr.authorAvatar.length > 0 ? (
          <img
            src={pr.authorAvatar}
            alt={pr.author}
            loading="lazy"
            className="size-5 shrink-0 rounded-full border border-border/60"
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill pr={pr} />
        <ChecksBadge pr={pr} />
        {pr.hasMyApproval ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/25 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-300">
            <CheckIcon className="size-3" aria-hidden="true" />
            Approved
          </span>
        ) : null}
        {pr.hasMyComment ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
            <MessageCircleIcon className="size-3" aria-hidden="true" />
            Commented
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          #{pr.number} · {pr.author} · {relativeTime(pr.updatedAt)}
        </span>
        {onOpenExternal ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenExternal(pr.url);
            }}
            className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            GitHub
          </button>
        ) : null}
      </div>
    </button>
  );
});

function Section({
  label,
  prs,
  emptyLabel,
  selectedPrNumber,
  onSelect,
  onOpenExternal,
}: {
  label: string;
  prs: ReadonlyArray<PullRequestSummary>;
  emptyLabel: string;
  selectedPrNumber: number | null;
  onSelect: (pr: PullRequestSummary) => void;
  onOpenExternal?: (url: string) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">{prs.length}</span>
      </div>
      {prs.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground/70">{emptyLabel}</p>
      ) : (
        <div className="space-y-1.5">
          {prs.map((pr) => (
            <PullRequestCard
              key={pr.number}
              pr={pr}
              isSelected={selectedPrNumber === pr.number}
              onSelect={onSelect}
              {...(onOpenExternal ? { onOpenExternal } : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function PullRequestListPanel({
  environmentId,
  cwd,
  selectedPrNumber,
  onSelect,
  onOpenExternal,
}: PullRequestListPanelProps) {
  const pullRequestsQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? gitPrEnvironment.pullRequests({ environmentId, input: { cwd } })
      : null,
  );
  const data = pullRequestsQuery.data;

  const sortedReview = useMemo(
    () => (data ? data.reviewRequested.toSorted(byUpdatedAtDesc) : []),
    [data],
  );
  const sortedMine = useMemo(() => (data ? data.myPrs.toSorted(byUpdatedAtDesc) : []), [data]);

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        Select a project to view pull requests.
      </div>
    );
  }

  if (pullRequestsQuery.isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <Spinner className="size-4" />
        Loading pull requests...
      </div>
    );
  }

  // Only surface an error screen when there is no cached data to fall back on.
  // A failed background refresh (e.g. a transient rate limit) keeps the last
  // good data, so we keep showing it rather than blanking the panel.
  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-destructive">
        <AlertCircleIcon className="size-4" aria-hidden="true" />
        <span>{pullRequestsQuery.error ?? "Failed to load pull requests."}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            pullRequestsQuery.refresh();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!data.ghAvailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <AlertCircleIcon className="size-4" aria-hidden="true" />
        <span>{data.error ?? "GitHub CLI unavailable."}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Pull Requests</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            pullRequestsQuery.refresh();
          }}
          disabled={pullRequestsQuery.isPending}
        >
          {pullRequestsQuery.isPending ? <Spinner className="size-3" /> : "Refresh"}
        </Button>
      </div>
      {pullRequestsQuery.error !== null ? (
        <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          <AlertCircleIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">
            Couldn’t refresh: {pullRequestsQuery.error}. Showing last results.
          </span>
        </div>
      ) : null}
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <Section
          label="Review Requested"
          prs={sortedReview}
          emptyLabel="No PRs waiting for your review."
          selectedPrNumber={selectedPrNumber}
          onSelect={onSelect}
          {...(onOpenExternal ? { onOpenExternal } : {})}
        />
        <Section
          label="My Pull Requests"
          prs={sortedMine}
          emptyLabel="You have no open pull requests."
          selectedPrNumber={selectedPrNumber}
          onSelect={onSelect}
          {...(onOpenExternal ? { onOpenExternal } : {})}
        />
      </div>
    </div>
  );
}

function byUpdatedAtDesc(a: PullRequestSummary, b: PullRequestSummary): number {
  const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return right - left;
}
