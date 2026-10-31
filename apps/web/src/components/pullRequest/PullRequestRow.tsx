import { EyeIcon, SearchIcon, TriangleAlertIcon, UserRoundXIcon } from "lucide-react";
import type { PullRequestAction } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import {
  PullRequestSpeedActions,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { memo, useState, type ReactNode, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import { observeResize } from "~/lib/observeResize";
import { PullRequestGlyph } from "./pullRequestIcons";
import { PullRequestLabelChip } from "./pullRequestPresentation";

/** The most label chips a row lays out; the rest only ever count toward its "+N". */
const MAX_ROW_LABELS = 3;
/** Room kept between the last whole chip and the "+N" chip (the row's gap-1). */
const LABEL_GAP_PX = 4;

/** observeResize shares one observer, so a long list does not hold one per row. */
function observeLabelFit(elements: readonly Element[], onResize: () => void): () => void {
  return observeResize(elements, onResize);
}

/**
 * A row's labels stay whole: the chips that fit the meta line show, and the rest fold into a
 * "+N" chip after them. Folded chips keep their place, invisible, and the "+N" floats over it,
 * so folding never changes how the line shares its room with the author and branch.
 */
export function PullRequestRowLabels({
  labels,
}: {
  labels: EnvironmentPullRequestEntry["labels"];
}) {
  const laidOut = labels.slice(0, MAX_ROW_LABELS);
  const [fit, setFit] = useState({ shown: laidOut.length, left: 0 });
  const observeGroup = (group: HTMLSpanElement | null) => {
    if (!group) return;
    const chips = [...group.querySelectorAll<HTMLElement>(":scope > [data-row-label]")];
    const more = group.querySelector<HTMLElement>(":scope > [data-row-labels-more]");
    const measure = () => {
      const groupBox = group.getBoundingClientRect();
      const moreWidth = more?.getBoundingClientRect().width ?? 0;
      let shown = 0;
      let left = 0;
      for (const [index, chip] of chips.entries()) {
        const right = chip.getBoundingClientRect().right - groupBox.left;
        const folded = labels.length - index - 1;
        // Half a pixel of slack: the line's flex shrink leaves fractions a whole chip still fits.
        if (right + (folded > 0 ? LABEL_GAP_PX + moreWidth : 0) > groupBox.width + 0.5) break;
        shown = index + 1;
        left = Math.round(right) + LABEL_GAP_PX;
      }
      setFit((current) =>
        current.shown === shown && current.left === left ? current : { shown, left },
      );
    };
    measure();
    // The chips too: a web font landing resizes them inside a line that keeps its width.
    return observeLabelFit([group, ...chips], measure);
  };
  if (labels.length === 0) return null;
  const folded = labels.length - fit.shown;
  return (
    <span
      ref={observeGroup}
      className="relative hidden min-w-0 items-center gap-1 overflow-hidden @md/pr-row-meta:flex"
    >
      {laidOut.map((label, index) => (
        <PullRequestLabelChip
          key={label.name}
          label={label}
          data-row-label=""
          className={cn("shrink-0", index >= fit.shown && "invisible")}
        />
      ))}
      {/* Kept while nothing is folded, unseen, so its width is known before it is needed. */}
      <Badge
        data-row-labels-more=""
        aria-hidden={folded === 0}
        size="sm"
        variant="secondary"
        className={cn("absolute top-1/2 -translate-y-1/2", folded === 0 && "invisible")}
        style={{ left: fit.left }}
        title={labels
          .slice(fit.shown)
          .map((label) => label.name)
          .join(", ")}
      >
        +{Math.max(folded, 1)}
      </Badge>
    </span>
  );
}

/**
 * Failing/running checks open their details; otherwise show the review or draft state.
 * Closed/merged rows return null so the caller omits the separator.
 * `prefix` identifies a folded stack layer as `#n: `.
 */
export function pullRequestRowStatus(entry: EnvironmentPullRequestEntry, prefix = "") {
  if (entry.state !== "open") return null;
  const checks = (label: string, toneClassName = "text-muted-foreground") =>
    entry.checksState === undefined ? null : (
      <PullRequestChecksPopover
        checksState={entry.checksState}
        environmentId={entry.environmentId}
        reference={{
          projectId: entry.projectId,
          repository: entry.repository,
          number: entry.number,
        }}
        label={<span className={cn("truncate", toneClassName)}>{prefix + label}</span>}
      />
    );
  if (entry.checksState === "failing") {
    return checks("Checks failing", "text-destructive-foreground");
  }
  if (entry.mergeability === "conflicting") {
    return (
      <span className="flex min-w-0 items-center gap-1.25 text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          {prefix}Conflicts with {entry.baseBranch}
        </span>
      </span>
    );
  }
  if (entry.reviewDecision === "changes-requested") {
    return (
      <span className="flex min-w-0 items-center gap-1.25 text-destructive-foreground">
        <UserRoundXIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{prefix}Changes requested</span>
      </span>
    );
  }
  if (entry.isDraft) {
    return (
      <span className="flex items-center gap-1.25">
        <PullRequestGlyph.draft aria-hidden className="size-3 shrink-0" />
        {prefix}Draft
      </span>
    );
  }
  if (entry.viewerReviewRequested) {
    return (
      <span className="flex min-w-0 items-center gap-1.25 text-warning-foreground">
        <EyeIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{prefix}Your review</span>
      </span>
    );
  }
  if (entry.checksState === "pending") return checks("Checks running");
  if (entry.reviewDecision === "review-required") return <span>{prefix}Review required</span>;
  if (entry.reviewDecision === "approved") {
    return (
      checks("Ready to merge", "text-success-foreground") ?? (
        <span className="text-success-foreground">{prefix}Approved</span>
      )
    );
  }
  return checks("Checks passing");
}

/**
 * a narrow column. The intrinsic size is the content box a skipped row reserves, which is the
 * two lines and the gap between them without the padding: a 61px row less 20px of `py-2.5`.
 */
export const PAGE_ROW_CLASS = "gap-3 rounded-lg px-3 py-2.5 [contain-intrinsic-block-size:41px]";

/** How a page row, and a folded stack, answers the pointer and the keyboard. */
export const PAGE_ROW_HOVER_CLASS = "hover:surface-ghost-hover";
export const PAGE_ROW_PRESS_CLASS =
  "cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

/** The first line's diff counts, in the mono the numbers line up in. */
export const PAGE_DIFF_STAT_CLASS = "font-mono text-2xs";

export type PullRequestRowTarget = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number"
>;

function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  statsKey,
  statsRef,
  rail,
  onSelect,
  hostActions,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  showProvider: boolean;
  environmentLabel?: string;
  matchedElsewhere?: boolean;
  /** Visibility key for deferred line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLDivElement>;
  /**
   * A layer inside an opened stack: the stack's rail takes the glyph's place, and the stack
   * chip goes, since the rows around it already are the stack.
   */
  rail?: ReactNode;
  onSelect: (entry: PullRequestRowTarget) => void;
  hostActions: ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const { Icon, providerName, terminology } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      data-pull-request-key={statsKey}
      className={cn(
        "flex items-center rounded-lg [content-visibility:auto] [contain-intrinsic-block-size:61px]",
        selected ? "bg-selection-subtle" : PAGE_ROW_HOVER_CLASS,
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          PAGE_ROW_CLASS,
          PAGE_ROW_PRESS_CLASS,
          "min-w-0 flex-1",
        )}
      >
        {rail ?? (
          <PullRequestRowGlyph
            state={entry.state}
            isDraft={entry.isDraft}
            mergeability={entry.mergeability}
            baseBranch={entry.baseBranch}
            // Centred on the title line.
            className="mt-0.5 self-start"
          />
        )}
        <PullRequestRowLines
          number={
            <span
              className={PULL_REQUEST_ROW_NUMBER_CLASS}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(sourceControlClients.get(entry.provider)),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              #{entry.number}
            </span>
          }
          title={entry.title}
          status={
            <>
              {entry.stack && !rail ? (
                <PullRequestStackPopover
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    host: entry.host,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                  membership={entry.stack}
                  terminology={sourceControlClients.get(entry.provider).changeRequest}
                  onSelect={(target) =>
                    onSelect({ ...target, host: entry.host, environmentId: entry.environmentId })
                  }
                />
              ) : null}
              <PullRequestChangeBreakdownStat
                environmentId={entry.environmentId}
                reference={{
                  projectId: entry.projectId,
                  host: entry.host,
                  repository: entry.repository,
                  number: entry.number,
                }}
                additions={entry.additions}
                deletions={entry.deletions}
                className={PAGE_DIFF_STAT_CLASS}
              />
            </>
          }
          metaClassName="@container/pr-row-meta"
          meta={
            <>
              {matchedElsewhere ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-micro" />
                    }
                  >
                    <span className="sr-only">matched in the description</span>
                    <SearchIcon aria-hidden className="size-3 shrink-0" />
                    <span aria-hidden className="hidden truncate @xs/pr-row-meta:block">
                      matched in the description
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">Matched in the description</TooltipPopup>
                </Tooltip>
              ) : null}
              {showProvider ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <Icon aria-label={providerName} className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup>{providerName}</TooltipPopup>
                </Tooltip>
              ) : null}
              {/* A narrow row (the list beside an open review, or a narrow window) keeps the branch, which tells
                rows apart, over the repository, which the scope above already names, and over the
                author's name, which the avatar's tooltip still gives. */}
              <PullRequestRowAuthor
                actor={entry.author}
                className="min-w-3.5 max-w-40"
                labelClassName="sr-only @3xl/pr-row-meta:not-sr-only @3xl/pr-row-meta:truncate"
              />
              {showProjectTitle ? (
                <>
                  <span aria-hidden className="hidden text-dim-foreground @3xl/pr-row-meta:inline">
                    ·
                  </span>
                  <span className="hidden truncate @3xl/pr-row-meta:inline">
                    {entry.repository}
                  </span>
                </>
              ) : null}
              <span className="min-w-12 truncate font-mono text-caption text-dim-foreground">
                {entry.headBranch}
              </span>
              {environmentLabel ? (
                <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
              ) : null}
              {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
            </>
          }
          metaStatus={pullRequestRowStatus(entry)}
          updatedAt={entry.updatedAt}
          layout="page"
        />
      </button>
      {hostActions.size > 0 ? (
        <PullRequestSpeedActions
          entry={entry}
          hostActions={hostActions}
          terminology={terminology}
          onActed={onActed}
          closing={closing}
          sweeping={sweeping}
          {...(onCloseSweepStart ? { onCloseSweepStart } : {})}
        />
      ) : null}
    </div>
  );
}

export const PullRequestRow = memo(PullRequestRowImpl);
