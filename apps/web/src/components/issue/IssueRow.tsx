import type { EnvironmentId, IssueListEntry } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import {
  PULL_REQUEST_PAGE_ROW_CLASS,
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLabels,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { IssueStateGlyph, issueTrackerPresentation } from "./issuePresentation";

export interface EnvironmentIssueEntry extends IssueListEntry {
  readonly environmentId: EnvironmentId;
}

export type IssueRowTarget = Pick<
  EnvironmentIssueEntry,
  "environmentId" | "projectId" | "tracker" | "host" | "connectionId" | "scope" | "key" | "url"
>;

/** The page row in the pull-request list's shape: state glyph, then key and title over meta. */
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
        <IssueStateGlyph state={entry.state} />
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{entry.displayKey}</span>}
          title={entry.title}
          status={
            <>
              {entry.assignees.length > 0 ? (
                <span className="flex items-center -space-x-1">
                  {entry.assignees.slice(0, 3).map((assignee) => (
                    <PullRequestActorAvatar
                      key={assignee.id ?? assignee.login}
                      actor={assignee}
                      className="ring-1 ring-background"
                    />
                  ))}
                </span>
              ) : null}
              {entry.commentCount !== null && entry.commentCount > 0 ? (
                <span className="inline-flex items-center gap-0.5 tabular-nums">
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount}
                </span>
              ) : null}
            </>
          }
          metaClassName="@container/pr-row-meta"
          meta={
            <>
              <PullRequestRowAuthor actor={entry.author} />
              <span className="truncate">{entry.projectTitle}</span>
              {showTracker ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <tracker.Icon aria-hidden className="size-3" />
                  <span className="sr-only">{tracker.providerName}</span>
                </span>
              ) : null}
              {showScope ? <span className="truncate">{entry.scope}</span> : null}
              {environmentLabel ? <span className="truncate">{environmentLabel}</span> : null}
              <PullRequestRowLabels labels={entry.labels} />
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
    </div>
  );
}

export const IssueRow = memo(IssueRowImpl);
