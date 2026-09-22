import { SearchIcon } from "lucide-react";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

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
import {
  PullRequestDiffStat,
  PullRequestLabelChip,
  PullRequestReviewDecisionGlyph,
} from "./pullRequestPresentation";

/**
 * Each slot past the first only appears once the meta line is wide enough to hold it, so a
 * narrow row shows one label and a "+N" while a wide one spreads out up to three. The "+N"
 * rides on whichever pill is the last visible one, and is hidden as soon as the next slot shows.
 */
const LABEL_SLOTS = [
  { pill: "", overflow: "@xl/pr-row-meta:hidden" },
  { pill: "hidden @xl/pr-row-meta:inline-flex", overflow: "@3xl/pr-row-meta:hidden" },
  { pill: "hidden @3xl/pr-row-meta:inline-flex", overflow: "" },
] as const;

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <PullRequestLabelChip key={label.name} label={label} className={slot.pill}>
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </PullRequestLabelChip>
        );
      })}
    </span>
  );
}

/**
 * The page row keeps a little more room around the shared lines than the panel, which sits in
 * a narrow column. The intrinsic size is the content box a skipped row reserves, which is the
 * two lines without the padding: a 56px row less 20px of `py-2.5`.
 */
const PAGE_ROW_CLASS = "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]";

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
  onSelect,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  /**
   * A search found this, but in something the row does not show — a description, a comment, a
   * commit message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  /** Used by the list's shared visibility observer to defer optional line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLButtonElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
}) {
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <button
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        "cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list costs what the
        // viewport shows, not what the pages have loaded. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestRowGlyph
        state={entry.state}
        isDraft={entry.isDraft}
        inMergeQueue={entry.inMergeQueue}
        mergeability={entry.mergeability}
        baseBranch={entry.baseBranch}
        // On the title line rather than between the lines, as main aligns it.
        className="mt-0.75 self-start"
      />
      <PullRequestRowLines
        number={
          // The number carries the link, here as much as on the detail: a right-click on it
          // copies the pull request's own address rather than opening the editing menu.
          <span
            className={PULL_REQUEST_ROW_NUMBER_CLASS}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void showPullRequestLinkContextMenu({
                url: entry.url,
                openLabel: openOnHostLabel(entry.provider),
                position: { x: event.clientX, y: event.clientY },
              });
            }}
          >
            #{entry.number}
          </span>
        }
        title={entry.title}
        signals={
          entry.state === "open" && entry.inMergeQueue ? null : (
            <>
              {entry.checksState === undefined ? null : (
                <PullRequestChecksPopover
                  checksState={entry.checksState}
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                />
              )}
              {/* Only a verdict the host actually reports: an approval, a request for changes,
                or a review the branch rules still require. No glyph on the common case of a
                pull request nobody has reviewed, so a row only wears a person when the person
                has said something. */}
              {entry.reviewDecision === undefined ? null : (
                <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
              )}
            </>
          )
        }
        status={
          <>
            {entry.stack ? (
              <PullRequestStackPopover
                environmentId={entry.environmentId}
                reference={{
                  projectId: entry.projectId,
                  host: entry.host,
                  repository: entry.repository,
                  number: entry.number,
                }}
                membership={entry.stack}
                onSelect={(target) =>
                  onSelect({ ...target, host: entry.host, environmentId: entry.environmentId })
                }
              />
            ) : null}
            <PullRequestDiffStat
              additions={entry.additions}
              deletions={entry.deletions}
              className="font-mono"
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
                    <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-[10px]" />
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
            <PullRequestRowAuthor
              actor={entry.author}
              className="min-w-3.5 max-w-40"
              labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
            />
            {showProjectTitle ? <span className="truncate">{entry.repository}</span> : null}
            {environmentLabel ? (
              <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
            ) : null}
            {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
          </>
        }
        updatedAt={entry.updatedAt}
      />
    </button>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
