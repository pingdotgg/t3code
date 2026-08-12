import type {
  EnvironmentId,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestRef,
} from "@t3tools/contracts";
import { SmilePlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";

const PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

const EMPTY_PENDING: ReadonlyMap<PullRequestReactionContent, boolean> = new Map();

/** What the host last said, so a press in flight is forgotten the moment the real counts land. */
function reactionsSignature(reactions: ReadonlyArray<PullRequestReaction>): string {
  return reactions
    .map((reaction) => `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 1 : 0}`)
    .join(" ");
}

/**
 * The reaction pills under a remark, and the picker that adds one. The same bar serves the
 * description, a conversation comment and a review thread's comments: what differs between them
 * is only which subject the host is told about.
 *
 * The add button is revealed by hovering the remark it belongs to, the way GitHub's is, so the
 * parent must carry `group`. It stays put once there is something to press it beside, while the
 * picker is open, and whenever it is focused — a control only a mouse can find is no control.
 */
export function PullRequestReactionBar({
  reactions,
  canReact,
  subjectId,
  environmentId,
  reference,
  onRefresh,
  className,
}: {
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly canReact: boolean;
  /** Absent reacts to the change request itself, which is where its description's reactions live. */
  readonly subjectId?: string | undefined;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onRefresh: () => void;
  readonly className?: string | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<{
    readonly signature: string;
    readonly values: ReadonlyMap<PullRequestReactionContent, boolean>;
  }>({ signature: "", values: EMPTY_PENDING });
  const setReaction = useAtomCommand(pullRequestEnvironment.setReaction, { reportFailure: false });

  const signature = reactionsSignature(reactions);
  const values = pending.signature === signature ? pending.values : EMPTY_PENDING;
  const shown = applyPendingPullRequestReactions(reactions, values);

  const toggle = async (content: PullRequestReactionContent, reacted: boolean) => {
    setPending({ signature, values: new Map([...values, [content, reacted]]) });
    const result = await setReaction({
      environmentId,
      input: {
        ...reference,
        ...(subjectId === undefined ? {} : { subjectId }),
        content,
        reacted,
      },
    });
    if (result._tag === "Failure") {
      setPending((current) => {
        const next = new Map(current.values);
        next.delete(content);
        return { signature: current.signature, values: next };
      });
      toastManager.add({ type: "error", title: "The reaction could not be saved" });
      return;
    }
    onRefresh();
  };

  if (shown.length === 0 && !canReact) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-pressed={reaction.viewerHasReacted}
                aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
                disabled={!canReact}
                className={cn(
                  PILL_CLASS,
                  reaction.viewerHasReacted
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border/70 bg-muted/40 text-muted-foreground",
                  canReact ? "hover:border-primary/60" : "cursor-default",
                )}
                onClick={() => void toggle(reaction.content, !reaction.viewerHasReacted)}
              />
            }
          >
            <span aria-hidden>{pullRequestReactionEmoji(reaction.content)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{pullRequestReactionTooltip(reaction)}</TooltipPopup>
        </Tooltip>
      ))}

      {canReact ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Add a reaction"
                className={cn(
                  PILL_CLASS,
                  "border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground",
                  shown.length === 0 &&
                    !pickerOpen &&
                    "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              />
            }
          >
            <SmilePlusIcon aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-auto" side="top" viewportClassName="py-2">
            <div className="flex items-center gap-0.5">
              {PULL_REQUEST_REACTION_ORDER.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    aria-label={pullRequestReactionName(content)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                      reacted && "bg-primary/10",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      void toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
