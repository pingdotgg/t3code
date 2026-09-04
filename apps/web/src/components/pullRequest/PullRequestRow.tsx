import { SearchIcon } from "lucide-react";
import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { pullRequestLabelColor, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestStateGlyph,
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
        const dot = pullRequestLabelColor(label.color);
        const remaining = labels.length - index - 1;
        return (
          <span
            key={label.name}
            className={cn(
              "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pl-1 pr-1.5 text-[10px] leading-3.5 text-muted-foreground",
              slot.pill,
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="truncate">{label.name}</span>
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

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
  onSelect: (entry: EnvironmentPullRequestEntry) => void;
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
        "grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list costs what the
        // viewport shows, not what the pages have loaded. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[contain-intrinsic-block-size:54px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestStateGlyph
        state={entry.state}
        isDraft={entry.isDraft}
        mergeability={entry.mergeability}
        baseBranch={entry.baseBranch}
      />
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
        <span className="col-start-1 row-start-1 block truncate text-sm font-medium text-foreground">
          {entry.title}
        </span>
        <span className="col-start-2 row-start-1 justify-self-end whitespace-nowrap text-xs text-muted-foreground/70 tabular-nums">
          {formatRelativeTimeLabel(entry.updatedAt)}
        </span>
        <PullRequestMetaLine className="@container/pr-row-meta col-start-1 row-start-2 overflow-hidden text-xs text-muted-foreground/70">
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
          <span className="flex shrink-0 items-center gap-1">
            {showProvider ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                  <Icon aria-label={providerName} className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>{providerName}</TooltipPopup>
              </Tooltip>
            ) : null}
            {/* The number carries the link, here as much as on the detail: a right-click on it
                copies the pull request's own address rather than opening the editing menu. */}
            <span
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
          </span>
          {showProjectTitle ? <span className="truncate">{entry.repository}</span> : null}
          {environmentLabel ? (
            <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
          ) : null}
          <PullRequestActorLabel
            actor={entry.author}
            className="min-w-4 max-w-40"
            labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
          />
          {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
          {/* Only a verdict somebody has actually given: "review required" is the absence of
              one, and saying so on every unreviewed row would say nothing. */}
          {entry.reviewDecision === "approved" || entry.reviewDecision === "changes-requested" ? (
            <span
              className={cn(
                "min-w-0 truncate",
                entry.reviewDecision === "approved"
                  ? "text-emerald-600/90 dark:text-emerald-400/80"
                  : "text-amber-600/90 dark:text-amber-400/80",
              )}
            >
              {entry.reviewDecision === "approved" ? "Approved" : "Changes requested"}
            </span>
          ) : null}
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
        </PullRequestMetaLine>
        <PullRequestDiffStat
          additions={entry.additions}
          deletions={entry.deletions}
          className="col-start-2 row-start-2 justify-self-end text-xs"
        />
      </span>
    </button>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
