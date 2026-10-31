import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  PanelRightIcon,
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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MiddleTruncate } from "../ui/middle-truncate";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "./pullRequestPresentation";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
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
    <div role="status" aria-label={caption ?? "Loading pull requests"} className="space-y-px">
      {caption ? (
        <p className="ps-10 pe-3 pb-1 text-meta text-muted-foreground/70">{caption}</p>
      ) : null}
      {/* A row's own lines: glyph on the title line, title and meta 20 and 16 tall with the
          diff stat and time at their ends, 61px rows with the list's 1px separators. */}
      <div className="motion-safe:animate-skeleton space-y-px">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-start gap-3 rounded-lg px-3 py-2.5">
            <GhostBar className="mt-0.5 size-4 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.25">
              <div className="flex h-5 items-center gap-2">
                <GhostBar className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
                <GhostBar className="ml-auto w-12 shrink-0" />
              </div>
              <div className="flex h-4 items-center gap-2">
                <GhostBar className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])} />
                <GhostBar className="ml-auto w-16 shrink-0" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The detail panel's two-row header shape. Keeping the chrome, summary facts, and description
 */
export function PullRequestDetailGhost({
  seed: entry,
  summary,
  actions,
  tabs = DEFAULT_DETAIL_TABS,
  activeTab,
  number,
  onBack,
  onClose,
}: {
  seed?: PullRequestListEntry | null;
  summary?: PullRequestSummary | null;
  actions?: ReactNode;
  tabs?: ReadonlyArray<{ value: string; label: string }>;
  activeTab?: string;
  number?: number;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
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
  const changedFiles = summary?.changedFiles ?? null;
  const selectedTab =
    tabs.find((item) => item.value === activeTab)?.value ?? tabs[0]?.value ?? "summary";

  return (
    <div
      role="status"
      aria-label={`Loading ${terminology.singular}`}
      className={cn(
        "flex h-[calc(100%+var(--surface-top-inset,0px))] min-h-0 flex-col overflow-hidden bg-(--code-surface) pt-under-header",
        !seed && "motion-safe:animate-skeleton",
      )}
      data-surface-reaches-under-header=""
    >
      <div className="@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border">
        <div className="mt-3 grid h-8 min-w-0 items-center overflow-hidden pl-4">
          <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            {onBack ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-ms-1.25"
                onClick={onBack}
                aria-label={`Back to this thread's ${terminology.plural}`}
              >
                <ArrowLeftIcon aria-hidden className="size-3.5" />
              </Button>
            ) : null}
            {seed ? (
              <>
                <InlineButton
                  onClick={() => void readLocalApi()?.shell.openExternal(seed.url)}
                  aria-label={`Open ${terminology.singular} #${seed.number} on host`}
                >
                  <span className={statePresentation?.toneClassName}>#{seed.number}</span>
                  <ExternalLinkIcon aria-hidden className="size-2.5" />
                </InlineButton>
                <span className="min-w-0 truncate text-label text-foreground">{seed.title}</span>
              </>
            ) : (
              <>
                <span className="shrink-0">#{number ?? "…"}</span>
                <GhostBar className="h-4 w-3/5" />
              </>
            )}
          </div>
        </div>
        <div className="mt-3 mr-3 flex h-8 shrink-0 items-center justify-end gap-1">
          {actions}
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

        <div className="col-span-2 min-w-0 px-4 pt-1 pb-2">
          <div className="flex min-h-8 min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            {seed ? (
              <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
                <PullRequestActorLabel
                  actor={seed.author ?? null}
                  tooltip={false}
                  className="min-w-0 max-w-28"
                />
                <span className="shrink-0 font-normal">
                  <RelativeTime timestamp={seed.updatedAt} />
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <GhostBar className="size-4 rounded-full" />
                <GhostBar className="h-3 w-24" />
              </span>
            )}
            <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
            <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-caption font-normal text-dim-foreground">
              {seed ? (
                <>
                  <code className="flex min-w-0 max-w-[40%] shrink-0 @max-sm/pr-header:hidden">
                    <MiddleTruncate value={seed.baseBranch} />
                  </code>
                  <ArrowLeftIcon
                    aria-label="receives changes from"
                    className="size-3 shrink-0 @max-sm/pr-header:hidden"
                  />
                  <code className="min-w-0 truncate rounded-kbd bg-secondary px-1.5 py-px text-muted-foreground">
                    {seed.headBranch}
                  </code>
                </>
              ) : (
                <GhostBar className="h-3 w-32" />
              )}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-1.5 pl-1.5 text-caption font-normal">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <FileDiffIcon aria-hidden className="size-3" />
                {changedFiles === null ? (
                  <GhostBar className="h-3 w-4" />
                ) : (
                  changedFiles.toLocaleString()
                )}
              </span>
              {seed ? (
                <PullRequestDiffStat
                  additions={seed.additions ?? 0}
                  deletions={seed.deletions ?? 0}
                  className="shrink-0 font-mono text-caption"
                />
              ) : (
                <GhostBar className="h-3 w-16" />
              )}
            </span>
          </div>
        </div>

        <nav
          className="col-span-2 flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2"
          aria-label={`${capitalizeTerm(terminology.singular)} tabs`}
          inert
        >
          <ToggleGroup
            className="shrink-0"
            size="segmented"
            variant="default"
            value={[selectedTab]}
          >
            {tabs.map((tab) => (
              <Toggle key={tab.value} value={tab.value} tabIndex={-1}>
                {tab.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* The readiness card's geometry: checks, reviews and conflicts rows over the merge. */}
        <section className="px-4 pt-3 pb-4">
          <div className="overflow-hidden rounded-card border border-border surface-card">
            <div className="divide-y divide-border">
              {["w-36", "w-32", "w-40"].map((width, index) => (
                // The divider sits outside the 40px row, as on the loaded collapsible rows.
                <div key={width}>
                  <div className="flex min-h-10 items-center gap-2.5 px-3 text-meta">
                    {index === 0 && checksPresentation ? (
                      <>
                        <checksPresentation.Icon
                          aria-hidden
                          className={cn("size-3.5 shrink-0", checksPresentation.toneClassName)}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {checksPresentation.label}
                        </span>
                      </>
                    ) : (
                      <>
                        <GhostBar className="size-3.5 shrink-0 rounded-full" />
                        <span className="min-w-0 flex-1">
                          <GhostBar className={cn("h-3", width)} />
                        </span>
                      </>
                    )}
                    <GhostBar className="h-3 w-16 shrink-0" />
                    <ChevronRightIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-dim-foreground"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-border p-3">
              <GhostBar className="h-8 w-full rounded-md sm:h-7" />
            </div>
          </div>
        </section>

        <section>
          <div className="sticky top-0 z-10 flex w-full items-center bg-(--code-surface) pr-4">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-label text-foreground">
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
      className="motion-safe:animate-skeleton px-4 py-4"
    >
      {/* The timeline's own lines: the rail at 11.5px, dots centered on its 24px markers,
          text from 34px, one 34px row per entry with its date at the end. */}
      <div className="relative mx-auto max-w-3xl">
        <span aria-hidden className="absolute top-2 bottom-5 left-[11.5px] w-px bg-border/70" />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="relative pb-2.5 pl-8.5">
            <GhostBar className="absolute top-2 left-2 size-2 rounded-full" />
            <div className="flex h-6 items-center gap-2">
              <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
              <GhostBar className="ml-auto w-8 shrink-0" />
            </div>
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
