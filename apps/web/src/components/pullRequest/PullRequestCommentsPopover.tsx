import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { FileCode2Icon, MessageSquareIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { reviewLineRangeLabel } from "@t3tools/client-runtime/review-selection";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Popover, PopoverPopup, PopoverTrigger, PopoverTitle } from "../ui/popover";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  ReviewThreadCard,
} from "./PullRequestReviewAnnotation";
import { usePendingReviewComments, type PendingReviewComment } from "./pullRequestReviewStore";
import { useReviewThreadActions } from "./useReviewThreadActions";

type CommentLocation = {
  readonly path: string;
  readonly line: number | null;
  readonly side: "left" | "right";
  readonly threadId?: string;
};

/** A PR-wide conversation checklist that stays reachable across all three review tabs. */
export function PullRequestCommentsPopover({
  environmentId,
  reference,
  detail,
  onRefresh,
  onOpenComment,
  onAddThreadCommentToComposer,
  onAddPendingToComposer,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  onRefresh: () => void;
  onOpenComment: (location: CommentLocation) => void;
  onAddThreadCommentToComposer?:
    | ((thread: PullRequestReviewThread, comment: PullRequestThreadComment) => void)
    | undefined;
  onAddPendingToComposer?: ((comment: PendingReviewComment) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const anchor = trigger
    ? {
        contextElement: trigger,
        getBoundingClientRect: () => {
          const button = trigger.getBoundingClientRect();
          const panel = trigger.closest("[data-pull-request-panel]")?.getBoundingClientRect();
          return new DOMRect(
            panel?.left ?? button.left,
            button.top,
            panel?.width ?? button.width,
            button.height,
          );
        },
      }
    : undefined;
  const [selectedStatus, setSelectedStatus] = useState<"resolved" | "unresolved" | "pending">(
    "unresolved",
  );
  const pending = usePendingReviewComments(reference, detail.reviewThreads);
  const actions = useReviewThreadActions(environmentId, reference, detail, onRefresh);
  // Hosted drafts are represented by the merged pending list, so they get one checklist entry.
  const threads = detail.reviewThreads.flatMap((thread) => {
    const comments = thread.comments.filter((comment) => !comment.pendingReviewId);
    return comments.length ? [{ ...thread, comments }] : [];
  });
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const resolved = threads.filter((thread) => thread.isResolved);
  const openCount = unresolved.length + pending.length;
  const status =
    selectedStatus === "pending" && pending.length === 0 ? "unresolved" : selectedStatus;
  if (status !== selectedStatus) setSelectedStatus(status);
  const visibleThreads =
    status === "resolved" ? resolved : status === "unresolved" ? unresolved : [];
  const jump = (location: CommentLocation) => {
    setOpen(false);
    onOpenComment(location);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={setTrigger}
        render={<Button size="xs" variant="ghost-muted" />}
        aria-label={`Comments, ${openCount} open`}
      >
        <MessageSquareIcon className="size-3.5" />
        Comments
        <Badge variant="secondary" size="sm">
          {openCount}
        </Badge>
      </PopoverTrigger>
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="end"
        alignOffset={12}
        collisionPadding={12}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        padding="none"
        width="auto"
      >
        <div className="flex max-h-[min(75vh,48rem,var(--available-height))] w-[min(28rem,calc(100vw-2rem))] min-w-0 flex-col [--text-sm:0.8125rem]">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <PopoverTitle>Comments</PopoverTitle>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className="ml-auto"
              aria-label="Close comments"
              onClick={() => setOpen(false)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <div className="border-b border-border/60 px-3 py-2">
            <ToggleGroup
              variant="segmented"
              className="w-full"
              aria-label="Comment status"
              value={[status]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "resolved" || next === "unresolved" || next === "pending")
                  setSelectedStatus(next);
              }}
            >
              <Toggle value="unresolved" className="flex-1">
                Unresolved{" "}
                <Badge variant="secondary" size="sm">
                  {unresolved.length}
                </Badge>
              </Toggle>
              <Toggle value="resolved" className="flex-1">
                Resolved{" "}
                <Badge variant="secondary" size="sm">
                  {resolved.length}
                </Badge>
              </Toggle>
              {pending.length > 0 ? (
                <Toggle value="pending" className="flex-1">
                  Pending{" "}
                  <Badge variant="secondary" size="sm">
                    {pending.length}
                  </Badge>
                </Toggle>
              ) : null}
            </ToggleGroup>
          </div>
          <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto py-2 [overflow-wrap:anywhere]">
            {open ? (
              <>
                {visibleThreads.map((thread) => (
                  <div key={thread.id}>
                    <div className="mx-3 mt-2">
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        className="max-w-full"
                        onClick={() =>
                          jump({
                            path: thread.path,
                            line: thread.line,
                            side: thread.side,
                            threadId: thread.id,
                          })
                        }
                      >
                        <FileCode2Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{thread.path}</span>
                        {thread.line !== null ? (
                          <span className="shrink-0">{reviewLineRangeLabel(thread)}</span>
                        ) : null}
                      </Button>
                    </div>
                    <ReviewThreadCard
                      {...actions(thread)}
                      thread={thread}
                      workspaceRoot={detail.workspaceRoot}
                      canReact={detail.capabilities.reactions === true}
                      environmentId={environmentId}
                      reference={reference}
                      onReacted={onRefresh}
                      onAddToComposer={
                        onAddThreadCommentToComposer
                          ? (comment) => onAddThreadCommentToComposer(thread, comment)
                          : undefined
                      }
                    />
                  </div>
                ))}
                {(status === "pending" ? pending : []).map((comment) => (
                  <div key={comment.id}>
                    <div className="mx-3 mt-2">
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        className="max-w-full"
                        onClick={() =>
                          jump({
                            path: comment.path,
                            ...getReviewPositionAnchor(comment.position),
                          })
                        }
                      >
                        <FileCode2Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{comment.path}</span>
                      </Button>
                    </div>
                    <PendingReviewCommentCard
                      comment={comment}
                      environmentId={environmentId}
                      reference={reference}
                      canCopyLink={
                        detail.capabilities.review.draftComment === true &&
                        detail.viewerPermissions.comment
                      }
                      onAddToComposer={
                        onAddPendingToComposer ? () => onAddPendingToComposer(comment) : undefined
                      }
                    />
                  </div>
                ))}
                {visibleThreads.length === 0 && (status !== "pending" || pending.length === 0) ? (
                  <p className="px-4 py-5 text-sm text-muted-foreground">No {status} comments.</p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
