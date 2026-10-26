import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  PanelRightIcon,
  TagIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  capitalizeTerm,
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { Button, InlineButton } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import {
  PullRequestChecksStatusLine,
  PullRequestDetailHeaderBody,
  PullRequestDetailTabBar,
  PullRequestDetailTitleRow,
} from "./PullRequestDetailLayout";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestLabelChip,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "./pullRequestPresentation";

function GhostBar({ className }: { className?: string | undefined }) {
  return <span aria-hidden className={cn("block h-3 rounded bg-muted-foreground/15", className)} />;
}

const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];
const DEFAULT_DETAIL_TABS = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
] as const;

export function PullRequestListGhost({ rows = 7, caption }: { rows?: number; caption?: string }) {
  return (
    <div role="status" aria-label={caption ?? "Loading pull requests"} className="space-y-0.5">
      {/* Outside the pulse so the explanation stays readable. */}
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground/70 redesign:text-muted-foreground">
          {caption}
        </p>
      ) : null}
      <div className="motion-safe:animate-skeleton space-y-0.5">
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
    </div>
  );
}

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
  const terminology = sourceControlClients.get(seed?.provider).changeRequest;
  const statePresentation = seed
    ? resolvePullRequestState({
        state: seed.state,
        isDraft: seed.isDraft ?? false,
      })
    : null;
  // Passing list rollups can omit workflows awaiting approval; wait for detail.
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
      aria-label={`Loading ${terminology.singular}`}
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
                  aria-label={`Open ${terminology.singular} #${seed.number} on host`}
                >
                  <span className={statePresentation?.toneClassName}>#{seed.number}</span>
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
          <Button
            size="icon-xs"
            variant="ghost"
            disabled
            aria-label={`${capitalizeTerm(terminology.singular)} actions loading`}
          >
            <EllipsisIcon aria-hidden className="size-4" />
          </Button>
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Collapse ${terminology.singular} panel`}
              onClick={onClose}
            >
              <PanelRightIcon aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="col-span-2 grid grid-rows-[1fr]">
          <div className="min-h-0 overflow-hidden">
            <PullRequestDetailHeaderBody
              title={
                <PullRequestDetailTitleRow>
                  {seed ? (
                    <h1 className="truncate text-base font-semibold leading-snug">{seed.title}</h1>
                  ) : (
                    <GhostBar className="h-5 w-4/5 max-w-md" />
                  )}
                </PullRequestDetailTitleRow>
              }
              author={
                seed ? (
                  <PullRequestActorLabel actor={seed.author ?? null} tooltip={false} />
                ) : (
                  <span className="flex items-center gap-1.5">
                    <GhostBar className="size-4 rounded-full" />
                    <GhostBar className="h-3 w-14" />
                  </span>
                )
              }
              updated={
                seed ? (
                  <span>
                    updated <RelativeTime timestamp={seed.updatedAt} />
                  </span>
                ) : (
                  <GhostBar className="h-3 w-16" />
                )
              }
              checkout={
                checkout ? (
                  <PullRequestCopyableCode
                    key={checkout}
                    value={checkout}
                    target={`${terminology.singular} checkout command`}
                    copyLabel="Copy checkout command"
                    copiedLabel="Checkout command copied"
                    className="ml-auto font-mono"
                    tooltipSide="bottom"
                    {...(onCheckoutError ? { onError: onCheckoutError } : {})}
                  />
                ) : null
              }
              base={
                <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                  {seed ? (
                    <code className="flex min-w-0">
                      <MiddleTruncate value={seed.baseBranch} />
                    </code>
                  ) : (
                    <GhostBar className="h-3 w-12" />
                  )}
                </span>
              }
              head={
                seed ? (
                  <PullRequestCopyableCode
                    key={seed.headBranch}
                    value={seed.headBranch}
                    target="branch name"
                    copyLabel={`Copy ${terminology.singular} branch`}
                    copiedLabel="Branch name copied"
                    className="min-w-0 font-mono"
                  />
                ) : (
                  <GhostBar className="h-3 w-32 flex-1" />
                )
              }
              files={
                changedFiles === null ? (
                  <GhostBar className="h-3 w-10" />
                ) : (
                  `${changedFiles.toLocaleString()} ${changedFiles === 1 ? "file" : "files"}`
                )
              }
              diffStat={
                seed ? (
                  <PullRequestDiffStat
                    additions={seed.additions ?? 0}
                    deletions={seed.deletions ?? 0}
                    className="shrink-0 font-mono text-xs"
                  />
                ) : (
                  <GhostBar className="h-3 w-20" />
                )
              }
            />
          </div>
        </div>

        <PullRequestDetailTabBar tabs={tabs} value={selectedTab} inert>
          {checksPresentation ? (
            <PullRequestChecksStatusLine
              className={checksPresentation.toneClassName}
              icon={<checksPresentation.Icon aria-hidden className="size-3.5" />}
              label={checksPresentation.label}
            />
          ) : (
            <PullRequestChecksStatusLine
              icon={<GhostBar className="my-px size-3.5 rounded-full" />}
              label={<GhostBar className="w-28" />}
            />
          )}
        </PullRequestDetailTabBar>
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

export function PullRequestConversationGhost({
  rows = 3,
  terminology,
}: {
  rows?: number;
  terminology: ChangeRequestTerminology;
}) {
  return (
    <div
      role="status"
      aria-label={`Loading ${terminology.singular} conversation`}
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
