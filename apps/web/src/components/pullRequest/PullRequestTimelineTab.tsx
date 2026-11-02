import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  EnvironmentId,
  PullRequestActor,
  PullRequestCommit,
  PullRequestDetailView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  GitCommitHorizontalIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildPullRequestRail,
  isPullRequestVerdictStale,
  newestPullRequestCommitAt,
  visibleBody,
  type PullRequestRailEntry,
} from "./pullRequestDetail.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import {
  PullRequestActorAvatar,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeStaleLabel,
  pullRequestReviewOutcomeToneClassName,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

function TimelineRelativeTime({ timestamp }: { timestamp: string }) {
  const relative = useRelativeTimeState(timestamp);
  return relative.status === "relative" ? relative.value : null;
}

/** The round marker on the rail, holding the entry's own icon. */
function RailMarker({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-0 left-0 z-10 flex size-6 items-center justify-center rounded-full border border-border bg-(--code-surface) text-dim-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function RailRow({
  marker,
  markerClassName,
  children,
  at,
}: {
  marker: ReactNode;
  markerClassName?: string;
  children: ReactNode;
  at: string;
}) {
  return (
    <li className="relative min-h-6 pb-2.5 pl-8.5 [contain-intrinsic-block-size:34px] [content-visibility:auto]">
      <RailMarker {...(markerClassName ? { className: markerClassName } : {})}>{marker}</RailMarker>
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-body">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {children}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<time dateTime={at} className="shrink-0 text-meta text-muted-foreground" />}
          >
            <TimelineRelativeTime timestamp={at} />
          </TooltipTrigger>
          <TooltipPopup>{new Date(at).toLocaleString()}</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}

function Actor({ actor }: { actor: PullRequestActor | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <PullRequestActorAvatar actor={actor} />
      <span className="truncate font-medium text-foreground">{actor?.login ?? "ghost"}</span>
    </span>
  );
}

function Verb({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-muted-foreground", className)}>{children}</span>;
}

/** "✓ 4/4": how the commit's own checks came out, where the host rolls them up per commit. */
function CommitChecksPill({ checks }: { checks: NonNullable<PullRequestCommit["checks"]> }) {
  const variant =
    checks.state === "passing" ? "success" : checks.state === "failing" ? "error" : "warning";
  return (
    <Badge variant={variant}>
      {checks.state === "passing" ? (
        <CheckIcon aria-hidden />
      ) : checks.state === "failing" ? (
        <XIcon aria-hidden />
      ) : null}
      <span className="font-mono tabular-nums">
        {checks.passed}/{checks.total}
      </span>
      <span className="sr-only">
        {checks.state === "passing"
          ? " checks passed"
          : checks.state === "failing"
            ? " checks, some failing"
            : " checks, some still running"}
      </span>
    </Badge>
  );
}

function RailEntry({
  entry,
  detail,
  environmentId,
  threadRef,
  newestCommitAt,
  onOpenCommit,
  onOpenCode,
}: {
  entry: PullRequestRailEntry;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  newestCommitAt: string | null;
  onOpenCommit: (oid: string) => void;
  onOpenCode?: ((path: string) => void) | undefined;
}) {
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  const title = capitalizeTerm(term);
  switch (entry.kind) {
    case "opened":
      return (
        <RailRow at={entry.at} marker={<PullRequestGlyph.pullRequest className="size-3.5" />}>
          <Actor actor={entry.actor} />
          <Verb>opened this {term}</Verb>
        </RailRow>
      );
    case "merged":
      return (
        <RailRow
          at={entry.at}
          marker={<PullRequestGlyph.merged className="size-3.5" />}
          markerClassName="text-merged-foreground"
        >
          <span className="font-medium text-foreground">{title} merged</span>
        </RailRow>
      );
    case "closed":
      return (
        <RailRow
          at={entry.at}
          marker={<PullRequestGlyph.closed className="size-3.5" />}
          markerClassName="text-error-foreground"
        >
          <span className="font-medium text-foreground">{title} closed</span>
        </RailRow>
      );
    case "commit": {
      const { commit } = entry;
      const author = commit.authors?.[0] ?? null;
      return (
        <li className="relative min-h-6 pb-2.5 pl-8.5 [contain-intrinsic-block-size:34px] [content-visibility:auto]">
          <RailMarker>
            <GitCommitHorizontalIcon className="size-3.5" />
          </RailMarker>
          <button
            type="button"
            aria-label={`View commit ${commit.oid}`}
            onClick={() => onOpenCommit(commit.oid)}
            className="group flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-row text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {author ? <PullRequestActorAvatar actor={author} /> : null}
            <span className="min-w-0 flex-1 truncate text-foreground group-hover:underline">
              {commit.messageHeadline || "Untitled commit"}
            </span>
            <code className="shrink-0 font-mono text-meta text-muted-foreground">
              {commit.oid.slice(0, 7)}
            </code>
            {commit.checks ? <CommitChecksPill checks={commit.checks} /> : null}
          </button>
        </li>
      );
    }
    case "review-request":
      return (
        <RailRow at={entry.at} marker={<UserPlusIcon className="size-3.5" />}>
          <Actor actor={entry.actor} />
          <Verb>{entry.again ? "re-requested review from" : "requested review from"}</Verb>
          {entry.reviewers.map((reviewer) => (
            <Actor key={reviewer.login} actor={reviewer} />
          ))}
        </RailRow>
      );
    case "review": {
      const reviewUrl = entry.comment.url;
      const stale = isPullRequestVerdictStale(entry.at, newestCommitAt);
      const body = visibleBody(entry.comment.body);
      const first = entry.threads[0];
      const unresolved = entry.threads.filter((thread) => !thread.isResolved).length;
      const verb =
        entry.outcome === "approved"
          ? "approved"
          : entry.outcome === "changes-requested"
            ? "requested changes"
            : "had a review dismissed";
      return (
        <li className="relative min-h-6 pb-2.5 pl-8.5 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
          <RailMarker
            className={stale ? undefined : pullRequestReviewOutcomeToneClassName(entry.outcome)}
          >
            <PullRequestReviewOutcomeIcon outcome={entry.outcome} className="size-3.5" />
          </RailMarker>
          <div className="flex min-h-6 min-w-0 items-center gap-2 text-body">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
              <Actor actor={entry.comment.author} />
              <Tooltip disabled={!stale}>
                <TooltipTrigger render={<span className="text-muted-foreground" />}>
                  {verb}
                  {stale ? <span className="sr-only">, before the latest commits</span> : null}
                </TooltipTrigger>
                <TooltipPopup>{pullRequestReviewOutcomeStaleLabel(entry.outcome)}</TooltipPopup>
              </Tooltip>
            </div>
            {reviewUrl ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Open review on host"
                onClick={() => void readLocalApi()?.shell.openExternal(reviewUrl)}
              >
                <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
            <time dateTime={entry.at} className="shrink-0 text-meta text-muted-foreground">
              <TimelineRelativeTime timestamp={entry.at} />
            </time>
          </div>
          {body ? (
            <div className="text-body text-muted-foreground">
              <PullRequestMarkdown
                text={body}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
                threadRef={threadRef}
              />
            </div>
          ) : null}
          {first ? (
            <button
              type="button"
              disabled={!onOpenCode}
              onClick={() => onOpenCode?.(first.path)}
              className="group mt-1 flex w-full min-w-0 text-left outline-none"
            >
              <span className="flex w-full min-w-0 items-center gap-2 rounded-row text-body text-muted-foreground group-hover:text-foreground group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-ring">
                <span className="inline-flex min-w-0 items-center gap-1.5 rounded-kbd border border-border px-1.5 py-0.5 font-mono text-meta">
                  <FileCodeIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {first.path}
                    {first.line ? `:${first.line}` : ""}
                  </span>
                </span>
                <span className="shrink-0">
                  {entry.threads.length} {entry.threads.length === 1 ? "thread" : "threads"}
                </span>
                <span className="flex-1" />
                {unresolved > 0 ? <Badge variant="warning">Unresolved</Badge> : null}
                <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
              </span>
            </button>
          ) : null}
        </li>
      );
    }
  }
}

const LAST_SEEN_KEY_PREFIX = "t3code:pull-request-timeline-seen:";
// The stamp each pull request had when this page first showed its timeline. The tab remounts as
// its activity reloads, so the divider reads from here and stays put until the next page load.
const lastSeenBaselines = new Map<string, number | null>();

function getTimelineLastSeen(key: string): number | null {
  if (!lastSeenBaselines.has(key)) {
    let stored: number | null = null;
    try {
      const value = Number(window.localStorage.getItem(key));
      stored = value > 0 ? value : null;
    } catch {
      // Unreadable storage reads as never seen.
    }
    lastSeenBaselines.set(key, stored);
  }
  return lastSeenBaselines.get(key) ?? null;
}

/** When this browser last showed the pull request's timeline, before the current page load. */
function useTimelineLastSeen(url: string): number | null {
  const key = LAST_SEEN_KEY_PREFIX + url;
  const lastSeen = getTimelineLastSeen(key);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Record timeline visits in browser storage on mount and unmount.
  useEffect(() => {
    const stamp = () => {
      try {
        window.localStorage.setItem(key, String(Date.now()));
      } catch {
        // Private mode or a full quota: the divider just doesn't come back next time.
      }
    };
    stamp();
    return stamp;
  }, [key]);
  return lastSeen;
}

/** Splits entries seen last time from the ones that landed since. */
function NewSinceDivider({ lastSeen }: { lastSeen: number }) {
  const relative = useRelativeTimeState(new Date(lastSeen).toISOString());
  const relativeLabel =
    relative.status === "relative"
      ? relative.suffix === null
        ? relative.value
        : `${relative.value} ${relative.suffix}`
      : "";
  return (
    <li
      aria-label={`New since you looked ${relativeLabel}`}
      className="relative z-10 flex items-center gap-2 pb-3.5"
    >
      <span aria-hidden className="h-px flex-1 bg-info/40" />
      <Badge variant="info">New since you looked · {relativeLabel}</Badge>
      <span aria-hidden className="h-px flex-1 bg-info/40" />
    </li>
  );
}

export function PullRequestTimelineTab({
  scrollerRef,
  detail,
  environmentId,
  threadRef = null,
  order,
  onOpenCommit,
  onOpenCode,
}: {
  scrollerRef?: (node: HTMLElement | null) => void;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  order: "newest" | "oldest";
  onOpenCommit: (oid: string) => void;
  /** Opens the Code tab, where a review's line threads are read in place. */
  onOpenCode?: (path: string) => void;
}) {
  const entries = buildPullRequestRail(detail);
  const ordered = order === "newest" ? entries : entries.toReversed();
  const newestCommitAt = newestPullRequestCommitAt(detail.commits);
  const lastSeen = useTimelineLastSeen(detail.url);
  const isNew = (entry: (typeof ordered)[number]) =>
    lastSeen !== null && Date.parse(entry.at) > lastSeen;
  // The divider only means something with entries on both sides of it.
  const dividerIndex =
    lastSeen === null || !ordered.some(isNew) || ordered.every(isNew)
      ? -1
      : order === "newest"
        ? ordered.findIndex((entry) => !isNew(entry))
        : ordered.findIndex(isNew);

  return (
    <LegendList<PullRequestRailEntry>
      ref={(list: LegendListRef | null) => scrollerRef?.(list?.getScrollableNode() ?? null)}
      data={ordered}
      extraData={{ detail, environmentId, threadRef, newestCommitAt, dividerIndex, lastSeen }}
      keyExtractor={(entry) => `${entry.kind}:${entry.id}`}
      renderItem={({ item: entry, index }) => (
        <>
          {index === dividerIndex && lastSeen !== null ? (
            <NewSinceDivider lastSeen={lastSeen} />
          ) : null}
          <RailEntry
            entry={entry}
            detail={detail}
            environmentId={environmentId}
            threadRef={threadRef}
            newestCommitAt={newestCommitAt}
            onOpenCommit={onOpenCommit}
            onOpenCode={onOpenCode}
          />
        </>
      )}
      estimatedItemSize={140}
      className="h-full px-4"
      contentContainerClassName="relative min-w-0 before:absolute before:top-5 before:bottom-8 before:left-[11.5px] before:w-px before:bg-border"
      ListHeaderComponent={<div className="h-3" />}
      ListFooterComponent={<div className="h-3" />}
    />
  );
}
