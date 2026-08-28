import type { IssueListEntry, IssueListSort, IssueReactionContent } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";

import { memo } from "react";

import { cn } from "~/lib/utils";

import {
  SourceControlActorAvatar,
  SourceControlActorLabel,
} from "../sourceControl/actorPresentation";
import { ListRow } from "../sourceControl/ListRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getIssueProviderPresentation,
  IssueLabelChips,
  IssueStateGlyph,
} from "./issuePresentation";
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
  return (
    <div className={cn("group/row relative", onToggleSelection && "[&>button]:pl-10")}>
      <ListRow
        glyph={<IssueStateGlyph state={entry.state} stateReason={entry.stateReason} />}
        title={entry.title}
        providerName={providerName}
        ProviderIcon={Icon}
        showProvider={showProvider}
        number={entry.number}
        repository={showProjectTitle ? entry.repository : null}
        meta={[
          <SourceControlActorLabel key="author" actor={entry.author} className="max-w-40" />,
          entry.assignees.length > 0 ? (
            <Tooltip key="assignees">
              <TooltipTrigger
                render={
                  <span
                    className="flex shrink-0 items-center -space-x-1"
                    aria-label={`Assigned to ${entry.assignees.map((assignee) => assignee.login).join(", ")}`}
                  />
                }
              >
                {entry.assignees.slice(0, ASSIGNEE_FACES).map((assignee) => (
                  <SourceControlActorAvatar
                    key={assignee.login}
                    actor={assignee}
                    className="ring-1 ring-background"
                  />
                ))}
              </TooltipTrigger>
              <TooltipPopup side="top">
                Assigned to {entry.assignees.map((assignee) => assignee.login).join(", ")}
              </TooltipPopup>
            </Tooltip>
          ) : null,
          // Guarded here rather than left to the chips: a component that renders nothing is still a
          // child, and the meta line would draw a separator in front of it.
          entry.labels.length > 0 ? (
            <IssueLabelChips key="labels" labels={entry.labels} className="shrink-0" />
          ) : null,
        ]}
        matchedElsewhere={matchedElsewhere === true}
        updatedAt={entry.updatedAt}
        trailing={
          reactionSort?.startsWith("reactions") && reactionCount > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="flex items-center gap-1"
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
                    className="flex items-center gap-1"
                    aria-label={`${entry.commentCount.toLocaleString()} comments`}
                  />
                }
              >
                <MessageSquareIcon aria-hidden className="size-3" />
                {entry.commentCount.toLocaleString()}
              </TooltipTrigger>
              <TooltipPopup side="top">{entry.commentCount.toLocaleString()} comments</TooltipPopup>
            </Tooltip>
          ) : null
        }
        selected={selected}
        onSelect={() => onSelect(entry)}
      />
      {onToggleSelection ? (
        <Checkbox
          checked={selectionChecked}
          aria-label={`${selectionChecked ? "Deselect" : "Select"} ${entry.repository} issue #${entry.number}`}
          className={cn(
            "absolute top-1/2 left-3 z-10 -translate-y-1/2 transition-opacity",
            selectionChecked
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          )}
          onCheckedChange={() => onToggleSelection(entry)}
        />
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
