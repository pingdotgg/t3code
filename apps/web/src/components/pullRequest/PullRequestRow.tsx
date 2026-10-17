import type { PullRequestAction } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SearchIcon } from "lucide-react";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import {
  PullRequestSpeedActions,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";
import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PULL_REQUEST_PAGE_ROW_CLASS,
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowGlyph,
  PullRequestRowLabels,
  PullRequestRowLines,
} from "./PullRequestListRow";
import { PullRequestDiffStat, PullRequestReviewDecisionGlyph } from "./pullRequestPresentation";

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
  speedMode,
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
  /** Used by the list's shared visibility observer to defer optional line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  speedMode: boolean;
  hostActions: ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      data-pull-request-key={statsKey}
      className={cn(
        "flex items-center rounded-md [content-visibility:auto] [contain-intrinsic-block-size:56.5px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(PULL_REQUEST_ROW_CLASS, PULL_REQUEST_PAGE_ROW_CLASS)}
      >
        <PullRequestRowGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          baseBranch={entry.baseBranch}
          className="mt-0.75 self-start"
        />
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
          signals={
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
              {entry.reviewDecision === undefined ? null : (
                <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
              )}
            </>
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
                      <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-3xs" />
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
      {hostActions.size > 0 ? (
        <PullRequestSpeedActions
          entry={entry}
          hostActions={hostActions}
          visible={speedMode}
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
