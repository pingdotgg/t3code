import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { Fragment, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestChangeBreakdownRows } from "./PullRequestChangeBreakdownStat";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "./PullRequestListRow";
import {
  PAGE_DIFF_STAT_CLASS,
  PAGE_ROW_CLASS,
  PAGE_ROW_HOVER_CLASS,
  PAGE_ROW_PRESS_CLASS,
  PullRequestRow,
  PullRequestRowLabels,
  pullRequestRowStatus,
} from "./PullRequestRow";
import { PullRequestGlyph } from "./pullRequestIcons";
import { PullRequestDiffStat } from "./pullRequestPresentation";

/** How far a layer is from merging, worst first: the folded row speaks for the worst one. */
function layerRank(entry: EnvironmentPullRequestEntry) {
  if (entry.state !== "open") return 9;
  if (entry.checksState === "failing") return 0;
  if (entry.mergeability === "conflicting") return 1;
  if (entry.reviewDecision === "changes-requested") return 2;
  if (entry.isDraft) return 8;
  if (entry.checksState === "pending") return 3;
  if (entry.viewerReviewRequested) return 4;
  if (entry.reviewDecision === "review-required") return 5;
  return 6;
}

/** The layer's node on the chain and the rail: hollow while it is a draft. */
function layerDotClass(entry: EnvironmentPullRequestEntry) {
  if (entry.state === "merged") return "bg-merged-foreground";
  if (entry.state === "closed") return "bg-dim-foreground";
  if (entry.isDraft) return "border-[1.5px] border-dim-foreground bg-card";
  const rank = layerRank(entry);
  if (rank <= 2) return "bg-destructive";
  if (rank === 3) return "bg-warning";
  return "bg-success";
}

/**
 * Long stacks keep their ends, and the layer holding the stack up, and say how many layers sit
 * between them.
 */
const CHAIN_LIMIT = 4;

function chainLinks(
  entries: ReadonlyArray<EnvironmentPullRequestEntry>,
  worst: EnvironmentPullRequestEntry,
) {
  if (entries.length <= CHAIN_LIMIT) return entries.map((entry) => ({ entry, hidden: 0 }));
  const kept = new Set([0, entries.length - 1]);
  if (layerRank(worst) <= 2) kept.add(entries.indexOf(worst));
  const links: Array<{ entry: EnvironmentPullRequestEntry | null; hidden: number }> = [];
  let hidden = 0;
  entries.forEach((entry, index) => {
    if (!kept.has(index)) {
      hidden += 1;
      return;
    }
    if (hidden > 0) links.push({ entry: null, hidden });
    hidden = 0;
    links.push({ entry, hidden: 0 });
  });
  return links;
}

function StackChain({
  entries,
  worst,
}: {
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  worst: EnvironmentPullRequestEntry;
}) {
  return (
    <span className="flex min-w-0 shrink-[8] items-center gap-1.5 overflow-hidden pl-1">
      {chainLinks(entries, worst).map(({ entry, hidden }, index) => (
        <Fragment key={entry?.number ?? `more-${index}`}>
          {index > 0 ? (
            <ArrowRightIcon aria-hidden className="size-2.75 shrink-0 text-dim-foreground/70" />
          ) : null}
          {entry === null ? (
            <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>+{hidden}</span>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden className={cn("size-1.5 rounded-full", layerDotClass(entry))} />
              <span
                className={cn(
                  PULL_REQUEST_ROW_NUMBER_CLASS,
                  entry === worst && layerRank(entry) <= 2 && "text-muted-foreground",
                )}
              >
                #{entry.number}
              </span>
            </span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

/** The line up the stack with this layer's node on it; the top layer's line stops at its node. */
function StackRail({ entry, last }: { entry: EnvironmentPullRequestEntry; last: boolean }) {
  return (
    <span aria-hidden className="-my-2.5 flex w-4 shrink-0 flex-col items-center self-stretch">
      <span className="w-px flex-1 bg-foreground/15" />
      <span className={cn("size-2 shrink-0 rounded-full", layerDotClass(entry))} />
      <span className={cn("w-px flex-1", last ? null : "bg-foreground/15")} />
    </span>
  );
}

type RowProps = Omit<ComponentProps<typeof PullRequestRow>, "entry" | "selected" | "rail">;

/**
 * Two or more layers of one native stack, folded into one row that reads as the stack: the
 * bottom layer's title, the chain of layers, their summed diff and the worst layer's status.
 * Opening it lists every layer on a rail, each a full row that opens its review.
 */
export function PullRequestStackGroup({
  entries,
  isSelected,
  rowProps,
}: {
  /** Bottom layer first. */
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  isSelected: (entry: EnvironmentPullRequestEntry) => boolean;
  rowProps: (entry: EnvironmentPullRequestEntry) => RowProps;
}) {
  const holdsSelection = entries.some(isSelected);
  const [open, setOpen] = useState(holdsSelection);
  const [wasSelected, setWasSelected] = useState(holdsSelection);
  // Opening a layer from somewhere else (its link, the stack menu) shows where it sits.
  if (holdsSelection !== wasSelected) {
    setWasSelected(holdsSelection);
    if (holdsSelection) setOpen(true);
  }

  const bottom = entries[0]!;
  const terminology = sourceControlClients.get(bottom.provider).changeRequest;
  const worst = entries.reduce((a, b) => (layerRank(b) < layerRank(a) ? b : a));
  const allDrafts = entries.every((entry) => entry.state === "open" && entry.isDraft);
  const sameRank = entries.every((entry) => layerRank(entry) === layerRank(worst));
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  const updatedAt = entries.reduce<string | null>(
    (latest, entry) =>
      entry.updatedAt && (latest === null || entry.updatedAt > latest) ? entry.updatedAt : latest,
    null,
  );
  const labels = [
    ...new Map(
      entries.flatMap((entry) => entry.labels).map((label) => [label.name, label]),
    ).values(),
  ];
  const rank = layerRank(worst);
  const tone =
    rank <= 2
      ? "text-warning-foreground"
      : allDrafts
        ? "text-dim-foreground"
        : "text-success-foreground";

  const summary = (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Stack of ${entries.length} ${terminology.plural} from #${bottom.number}`}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        PAGE_ROW_PRESS_CLASS,
        // The opened stack's frame already sets it apart; only the folded row lights up.
        open ? null : PAGE_ROW_HOVER_CLASS,
      )}
    >
      <span className="mt-0.5 flex w-4 shrink-0 justify-center self-start">
        <PullRequestGlyph.stack aria-hidden className={cn("size-4", tone)} />
      </span>
      <PullRequestRowLines
        layout="page"
        title={bottom.title}
        number={
          <>
            <StackChain entries={entries} worst={worst} />
            <ChevronDownIcon
              aria-hidden
              // The folded row shows its chevron on hover, the opened one keeps it.
              className={cn(
                "size-3.25 shrink-0 text-dim-foreground transition-opacity",
                !open &&
                  "opacity-0 group-hover/pr-row:opacity-100 group-focus-visible/pr-row:opacity-100",
              )}
            />
          </>
        }
        status={
          additions === 0 && deletions === 0 ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <PullRequestDiffStat
                      additions={additions}
                      deletions={deletions}
                      className={PAGE_DIFF_STAT_CLASS}
                    />
                  </span>
                }
              />
              <TooltipPopup side="bottom" className="pointer-events-auto">
                <div className="grid max-h-[calc(var(--available-height)-0.5rem-2px)] gap-2 overflow-y-auto overscroll-contain">
                  {entries.map((entry) => (
                    <div key={entry.number}>
                      <span className="text-label">#{entry.number}</span>
                      <PullRequestChangeBreakdownRows
                        environmentId={entry.environmentId}
                        reference={{
                          projectId: entry.projectId,
                          host: entry.host,
                          repository: entry.repository,
                          number: entry.number,
                        }}
                        className="mt-1"
                      />
                    </div>
                  ))}
                </div>
              </TooltipPopup>
            </Tooltip>
          )
        }
        metaClassName="@container/pr-row-meta"
        meta={
          <>
            <PullRequestRowAuthor
              actor={bottom.author}
              className="min-w-3.5 max-w-40"
              labelClassName="sr-only @3xl/pr-row-meta:not-sr-only @3xl/pr-row-meta:truncate"
            />
            <span aria-hidden className="hidden text-dim-foreground @3xl/pr-row-meta:inline">
              ·
            </span>
            <span className="hidden truncate @3xl/pr-row-meta:inline">{bottom.repository}</span>
            <span className="min-w-12 truncate font-mono text-caption text-dim-foreground">
              {bottom.headBranch}
            </span>
            {labels.length > 0 ? <PullRequestRowLabels labels={labels} /> : null}
          </>
        }
        metaStatus={
          allDrafts ? (
            <span className="flex items-center gap-1.25">
              <PullRequestGlyph.draft aria-hidden className="size-3 shrink-0" />
              {entries.length === 2 ? "Both drafts" : `All ${entries.length} drafts`}
            </span>
          ) : (
            pullRequestRowStatus(worst, sameRank ? "" : `#${worst.number}: `)
          )
        }
        updatedAt={updatedAt}
      />
    </button>
  );

  return (
    // One wrapper either way, so toggling keeps the focused summary mounted. The frame is an
    // outline, drawn outside the rows: opening the stack moves none of the summary row's
    // contents, and the rows inside keep the frame's own corner.
    <div
      className={cn(
        "flex flex-col",
        open && "rounded-lg bg-foreground/[0.015] pb-0.5 outline outline-border/60",
      )}
    >
      {summary}
      {open ? (
        <>
          <Separator />
          <div className="flex flex-col">
            {entries.map((entry, index) => (
              <PullRequestRow
                key={entry.number}
                {...rowProps(entry)}
                entry={entry}
                selected={isSelected(entry)}
                rail={<StackRail entry={entry} last={index === entries.length - 1} />}
              />
            ))}
          </div>
        </>
      ) : (
        // Folded, no layer row is mounted to report it is on screen; these empty markers do, so
        // the summed line count still loads under the date sorts.
        entries.map((entry) => {
          const { statsKey, statsRef } = rowProps(entry);
          return (
            <div
              key={entry.number}
              aria-hidden
              ref={statsRef}
              data-pull-request-stats-key={statsKey}
            />
          );
        })
      )}
    </div>
  );
}
