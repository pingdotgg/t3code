import type { IssueListEntry, IssueListSort, IssueReactionContent } from "@t3tools/contracts";
import { MessageSquareIcon, SearchIcon } from "lucide-react";

import { memo } from "react";

import { cn } from "~/lib/utils";

import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getIssueProviderPresentation, IssueRowLabels, IssueStateGlyph } from "./issuePresentation";
import { Checkbox } from "../ui/checkbox";

const REACTION_SORT: Partial<
  Record<IssueListSort, { readonly emoji: string; readonly content?: IssueReactionContent }>
> = {
  reactions: { emoji: "👍" },
  "reactions-thumbs-up": { emoji: "👍", content: "thumbs-up" },
  "reactions-thumbs-down": { emoji: "👎", content: "thumbs-down" },
  "reactions-rocket": { emoji: "🚀", content: "rocket" },
  "reactions-hooray": { emoji: "🎉", content: "hooray" },
  "reactions-eyes": { emoji: "👀", content: "eyes" },
  "reactions-heart": { emoji: "❤️", content: "heart" },
  "reactions-laugh": { emoji: "😄", content: "laugh" },
  "reactions-confused": { emoji: "😕", content: "confused" },
};

/** Faces, not names: past a few of them the meta line becomes a list nobody reads. */
const ASSIGNEE_FACES = 3;

const PAGE_ROW_CLASS = "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]";

function IssueRowImpl({
  entry,
  selected,
  selectionChecked,
  showProjectTitle,
  showProvider,
  matchedElsewhere,
  reactionSort,
  onSelect,
  onToggleSelection,
}: {
  entry: IssueListEntry;
  selected: boolean;
  selectionChecked?: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /**
   * A search found this, but in something the row does not show — a body, a comment. Saying so is
   * the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  reactionSort?: IssueListSort | undefined;
  onSelect: (entry: IssueListEntry) => void;
  onToggleSelection?: (entry: IssueListEntry) => void;
}) {
  const reactionKind = reactionSort === undefined ? undefined : REACTION_SORT[reactionSort];
  const reactionCount =
    reactionKind !== undefined
      ? (entry.reactions ?? []).reduce(
          (total, reaction) =>
            reactionKind.content === undefined || reaction.content === reactionKind.content
              ? total + reaction.count
              : total,
          0,
        )
      : 0;
  const { Icon, providerName } = getIssueProviderPresentation(entry.provider);
  const assignees = entry.assignees.map((assignee) => assignee.login).join(", ");
  return (
    <div className="group/row relative">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          PAGE_ROW_CLASS,
          "cursor-pointer transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "[content-visibility:auto]",
        )}
      >
        <span
          className={cn(
            "mt-0.75 flex w-4 shrink-0 justify-center self-start",
            onToggleSelection && "group-hover/row:opacity-0",
            selectionChecked && "opacity-0",
          )}
        >
          <IssueStateGlyph state={entry.state} stateReason={entry.stateReason} />
        </span>
        <PullRequestRowLines
          number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{entry.number}</span>}
          title={entry.title}
          status={
            reactionSort?.startsWith("reactions") && reactionCount > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="flex items-center gap-1 tabular-nums text-muted-foreground"
                      aria-label={`${reactionCount.toLocaleString()} reactions`}
                    />
                  }
                >
                  <span aria-hidden>{reactionKind?.emoji ?? "👍"}</span>
                  {reactionCount.toLocaleString()}
                </TooltipTrigger>
                <TooltipPopup side="top">{reactionCount.toLocaleString()} reactions</TooltipPopup>
              </Tooltip>
            ) : entry.commentCount > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="flex items-center gap-1 tabular-nums text-muted-foreground"
                      aria-label={`${entry.commentCount.toLocaleString()} comments`}
                    />
                  }
                >
                  <MessageSquareIcon aria-hidden className="size-3" />
                  {entry.commentCount.toLocaleString()}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {entry.commentCount.toLocaleString()} comments
                </TooltipPopup>
              </Tooltip>
            ) : null
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
              {entry.assignees.length > 0 ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex shrink-0 items-center -space-x-1"
                        aria-label={`Assigned to ${assignees}`}
                      />
                    }
                  >
                    {entry.assignees.slice(0, ASSIGNEE_FACES).map((assignee) => (
                      <PullRequestActorAvatar
                        key={assignee.login}
                        actor={assignee}
                        className="size-3.5 ring-1 ring-background"
                      />
                    ))}
                  </TooltipTrigger>
                  <TooltipPopup side="top">Assigned to {assignees}</TooltipPopup>
                </Tooltip>
              ) : null}
              <IssueRowLabels labels={entry.labels} />
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
      {onToggleSelection ? (
        <span
          className={cn(
            "absolute top-3 left-3 z-10 inline-flex transition-opacity",
            selectionChecked
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 has-focus-visible:opacity-100",
          )}
        >
          <Checkbox
            checked={selectionChecked}
            aria-label={`${selectionChecked ? "Deselect" : "Select"} ${entry.repository} issue #${entry.number}`}
            onCheckedChange={() => onToggleSelection(entry)}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const IssueRow = memo(IssueRowImpl);
