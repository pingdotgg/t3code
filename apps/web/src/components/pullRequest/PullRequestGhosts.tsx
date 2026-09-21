/**
 * Loading states specific to the pull request surface — the first list, a search under way,
 * and a detail panel opening — use bars in the geometry of the content they stand for, pulsing
 * on one composited layer. Diff loading uses the shared diff-panel skeleton instead.
 *
 * The bars share the app-wide `Skeleton` tone (`muted-foreground` at low alpha, which reads on
 * both themes) and the single `animate-skeleton` pulse, applied once on the container so any
 * number of bars costs one opacity animation.
 */
import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  PanelRightIcon,
  TagIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button, InlineButton } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MiddleTruncate } from "../ui/middle-truncate";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestLabelChip,
  PullRequestMetaLine,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "./pullRequestPresentation";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** Widths cycle rather than randomize, so the ghost renders the same on every pass. */
const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];
const DEFAULT_DETAIL_TABS = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
] as const;

/** Rows in the list's own grid — glyph, title over meta, time over diffstat. */
export function PullRequestListGhost({
  rows = 7,
  caption,
}: {
  rows?: number;
  /** Said where the group headers speak, for the states with something to say — a search. */
  caption?: string;
}) {
  return (
    <div
      role="status"
      aria-label={caption ?? "Loading pull requests"}
      className="motion-safe:animate-skeleton space-y-0.5"
    >
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">{caption}</p>
      ) : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2.5"
        >
          <GhostBar className="size-4 rounded-full" />
          <div className="min-w-0 space-y-1.5">
            <GhostBar className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])} />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <GhostBar className="w-12" />
            <GhostBar className="w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The detail panel's current expanded shape. Keeping the chrome, summary facts, and description
 * boundaries in the ghost prevents the loaded pull request from replacing one layout with
 * another a moment later.
 */
export function PullRequestDetailGhost({
  seed: entry,
  summary,
  actions,
  checkoutCommand,
  tabs = DEFAULT_DETAIL_TABS,
  activeTab,
  number,
  onBack,
  onClose,
  onCheckoutError,
}: {
  seed?: PullRequestListEntry | null;
  summary?: PullRequestSummary | null;
  actions?: ReactNode;
  checkoutCommand?: string | null;
  tabs?: ReadonlyArray<{ value: string; label: string }>;
  /** The panel's current tab, so the highlight does not jump when the detail arrives. */
  activeTab?: string;
  number?: number;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  onCheckoutError?: ((error: Error) => void) | undefined;
}) {
  const seed = summary
    ? {
        ...entry,
        ...summary,
        isDraft: summary.isDraft ?? entry?.isDraft,
      }
    : entry;
  const statePresentation = seed
    ? resolvePullRequestState({
        state: seed.state,
        isDraft: seed.isDraft ?? false,
      })
    : null;
  // Passing list rollups can omit workflows awaiting approval; wait for detail to claim success.
  const checksPresentation =
    seed?.checksState === "failing" || seed?.checksState === "pending"
      ? pullRequestChecksStatePresentation(seed.checksState)
      : null;
  const checkout = checkoutCommand ?? null;
  const changedFiles = summary?.changedFiles ?? null;
  const selectedTab =
    tabs.find((item) => item.value === activeTab)?.value ?? tabs[0]?.value ?? "summary";

  return (
    <div
      role="status"
      aria-label="Loading pull request"
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background",
        !seed && "motion-safe:animate-skeleton",
      )}
    >
      <div className="@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        <div className="pl-4 grid h-7 min-w-0 items-center overflow-hidden">
          <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground sm:text-xs">
            {onBack ? (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                className="-ml-1.5"
                onClick={onBack}
                aria-label="Back to this thread's pull requests"
              >
                <ArrowLeftIcon aria-hidden className="size-3.5" />
              </Button>
            ) : null}
            {seed ? (
              <>
                <span className="min-w-0 truncate font-medium">{seed.repository}</span>
                <InlineButton
                  onClick={() => void readLocalApi()?.shell.openExternal(seed.url)}
                  className={cn(
                    "font-medium underline-offset-2 hover:underline",
                    statePresentation?.toneClassName,
                  )}
                  aria-label={`Open pull request #${seed.number} on host`}
                >
                  #{seed.number}
                  <ExternalLinkIcon aria-hidden className="size-2.5" />
                </InlineButton>
              </>
            ) : (
              <>
                <GhostBar className="w-24" />
                <span className="shrink-0 text-xs text-muted-foreground">#{number ?? "…"}</span>
              </>
            )}
          </div>
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end gap-1">
          {actions ?? <GhostBar className="h-6 w-16 rounded-md" />}
          <Button size="icon-xs" variant="ghost" disabled aria-label="Pull request actions loading">
            <EllipsisIcon aria-hidden className="size-4" />
          </Button>
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse pull request panel"
              onClick={onClose}
            >
              <PanelRightIcon aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="col-span-2 grid grid-rows-[1fr]">
          <div className="min-h-0 overflow-hidden">
            <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
              {seed ? (
                <div className="flex min-h-7 min-w-0 items-center sm:min-h-6">
                  <h1 className="truncate text-base font-semibold leading-snug">{seed.title}</h1>
                </div>
              ) : (
                <div className="flex min-h-7 min-w-0 items-center sm:min-h-6">
                  <GhostBar className="h-5 w-4/5 max-w-md" />
                </div>
              )}
              <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {seed ? (
                  <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
                    <PullRequestActorLabel
                      actor={seed.author ?? null}
                      className="font-medium"
                      tooltip={false}
                    />
                    <span>updated {formatRelativeTimeLabel(seed.updatedAt)}</span>
                  </PullRequestMetaLine>
                ) : (
                  <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      <GhostBar className="size-4 rounded-full" />
                      <GhostBar className="h-3 w-14" />
                    </span>
                    <GhostBar className="h-3 w-16" />
                  </PullRequestMetaLine>
                )}
                {checkout ? (
                  <PullRequestCopyableCode
                    key={checkout}
                    value={checkout}
                    target="pull request checkout command"
                    copyLabel="Copy checkout command"
                    copiedLabel="Checkout command copied"
                    className="ml-auto font-mono"
                    tooltipSide="bottom"
                    {...(onCheckoutError ? { onError: onCheckoutError } : {})}
                  />
                ) : null}
              </div>

              <div className="mt-4 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground/70">
                  {seed ? (
                    <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                      <code className="flex min-w-0">
                        <MiddleTruncate value={seed.baseBranch} />
                      </code>
                    </span>
                  ) : (
                    <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                      <GhostBar className="h-3 w-12" />
                    </span>
                  )}
                  <ArrowLeftIcon
                    aria-label="receives changes from"
                    className="size-3.5 shrink-0 opacity-60"
                  />
                  {seed ? (
                    <PullRequestCopyableCode
                      key={seed.headBranch}
                      value={seed.headBranch}
                      target="branch name"
                      copyLabel="Copy pull request branch"
                      copiedLabel="Branch name copied"
                      className="min-w-0 font-mono"
                    />
                  ) : (
                    <GhostBar className="h-3 w-32 flex-1" />
                  )}
                </span>
                <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
                  <span className="inline-flex min-w-16 items-center justify-end gap-1.5 tabular-nums">
                    <FileDiffIcon aria-hidden className="size-3.5" />
                    {changedFiles === null ? (
                      <GhostBar className="h-3 w-10" />
                    ) : (
                      `${changedFiles.toLocaleString()} ${changedFiles === 1 ? "file" : "files"}`
                    )}
                  </span>
                  {seed ? (
                    <PullRequestDiffStat
                      additions={seed.additions ?? 0}
                      deletions={seed.deletions ?? 0}
                      className="shrink-0 font-mono text-xs"
                    />
                  ) : (
                    <GhostBar className="h-3 w-20" />
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        <nav
          className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
          aria-label="Pull request tabs"
          inert
        >
          <ToggleGroup
            className="shrink-0"
            size="segmented"
            variant="segmented"
            value={[selectedTab]}
          >
            {tabs.map((tab) => (
              <Toggle key={tab.value} value={tab.value} tabIndex={-1}>
                {tab.label}
              </Toggle>
            ))}
          </ToggleGroup>
          {checksPresentation ? (
            <span
              className={cn(
                "ml-auto inline-flex items-center gap-1.5 text-xs",
                checksPresentation.toneClassName,
              )}
            >
              <checksPresentation.Icon aria-hidden className="size-3.5" />
              {checksPresentation.label}
            </span>
          ) : (
            <GhostBar className="ml-auto h-3 w-32" />
          )}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <section className="px-4 pt-2.5 pb-1">
          <div className="space-y-2">
            <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <UsersIcon aria-hidden className="size-3.5" />
                Reviewers
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                <GhostBar className="h-3 w-10" />
                <Button size="icon-xs" variant="ghost" disabled aria-label="Reviewers loading">
                  <UserPlusIcon aria-hidden className="size-3.5" />
                </Button>
              </span>
            </div>
            <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <TagIcon aria-hidden className="size-3.5" />
                Labels
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-1 text-foreground">
                {entry?.labels ? (
                  entry.labels.length > 0 ? (
                    entry.labels.map((label) => (
                      <PullRequestLabelChip
                        key={label.name}
                        label={label}
                        size="default"
                        className="max-w-48"
                      />
                    ))
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )
                ) : (
                  <>
                    <GhostBar className="h-4.5 w-24" />
                    <GhostBar className="h-4.5 w-20" />
                  </>
                )}
                <Button size="icon-xs" variant="ghost" disabled aria-label="Labels loading">
                  <TagIcon aria-hidden className="size-3.5" />
                </Button>
              </span>
            </div>
          </div>
        </section>

        <section>
          <div className="sticky top-0 z-10 flex w-full items-center bg-background pr-4">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground">
              <span>Description</span>
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 rotate-90 text-muted-foreground/60"
              />
            </div>
          </div>
          <div className="space-y-3 px-4 pb-4">
            <GhostBar className="h-5 w-40" />
            <div className="space-y-2">
              <GhostBar className="h-4 w-full" />
              <GhostBar className="h-4 w-11/12" />
              <GhostBar className="h-4 w-4/5" />
              <GhostBar className="h-4 w-2/3" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** People-shaped: an avatar and a name, in the reviewer picker's own row height. */
export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading people"
      className="motion-safe:animate-skeleton space-y-1 p-1"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 rounded-md px-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}

/** The timeline's own shape: dots on the rail, a line and a date to each. */
export function PullRequestTimelineGhost({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading timeline"
      className="motion-safe:animate-skeleton px-4 py-5"
    >
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="relative pb-5">
            <GhostBar className="absolute -left-[1.55rem] top-1 size-2 rounded-full" />
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className="mt-1.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A compact placeholder for the conversation while the core detail is already readable. */
export function PullRequestConversationGhost({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading pull request conversation"
      className="motion-safe:animate-skeleton space-y-4 py-2"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2">
          <GhostBar className="size-5 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
            <GhostBar className="w-full" />
            <GhostBar className="w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
