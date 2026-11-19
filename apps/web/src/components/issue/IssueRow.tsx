import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  PAGE_ROW_CLASS,
  PAGE_ROW_HOVER_CLASS,
  PAGE_ROW_PRESS_CLASS,
  PullRequestRowLabels,
} from "../pullRequest/PullRequestRow";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssueStateGlyph, issueTrackerPresentation } from "./issuePresentation";

export type IssueRowTarget = Pick<
  EnvironmentIssueEntry,
  "environmentId" | "projectId" | "tracker" | "host" | "scope" | "key" | "url"
>;

/** The pull request page row with an issue in it: state glyph, title and key over its meta. */
function IssueRowImpl({
  entry,
  selected,
  showScope,
  showTracker,
  environmentLabel,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  /** Only when the list spans more than one scope, where the key alone is ambiguous. */
  showScope: boolean;
  /** Only when the list spans more than one tracker or host. */
  showTracker: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string | undefined;
  onSelect: (entry: IssueRowTarget) => void;
}) {
  const tracker = issueTrackerPresentation(entry.tracker);
  return (
    <div
      className={cn(
        "flex items-center rounded-lg [content-visibility:auto] [contain-intrinsic-block-size:61px]",
        selected ? "bg-selection-subtle" : PAGE_ROW_HOVER_CLASS,
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(PULL_REQUEST_ROW_CLASS, PAGE_ROW_CLASS, PAGE_ROW_PRESS_CLASS, "min-w-0 flex-1")}
      >
        {/* Centred on the title line, in the pull request glyph's column. */}
        <span className="mt-0.5 flex w-4 shrink-0 justify-center self-start">
          <IssueStateGlyph state={entry.state} />
        </span>
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{entry.displayKey}</span>}
          title={entry.title}
          status={
            <>
              {entry.assignees.length > 0 ? (
                <span className="flex items-center -space-x-1">
                  {entry.assignees.slice(0, 3).map((assignee) => (
                    <PullRequestActorAvatar
                      key={assignee.login}
                      actor={assignee}
                      className="ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : null}
              {entry.commentCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums text-muted-foreground">
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount}
                </span>
              ) : null}
            </>
          }
          metaClassName="@container/pr-row-meta"
          meta={
            <>
              {showTracker ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <tracker.Icon aria-label={tracker.providerName} className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup>{tracker.providerName}</TooltipPopup>
                </Tooltip>
              ) : null}
              <PullRequestRowAuthor
                actor={entry.author}
                className="min-w-3.5 max-w-40"
                labelClassName="sr-only @md/pr-row-meta:not-sr-only @md/pr-row-meta:truncate"
              />
              {showScope ? <span className="min-w-12 truncate">{entry.scope}</span> : null}
              {environmentLabel ? (
                <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
              ) : null}
              {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
            </>
          }
          updatedAt={entry.updatedAt}
          layout="page"
        />
      </button>
    </div>
  );
}

export const IssueRow = memo(IssueRowImpl);
