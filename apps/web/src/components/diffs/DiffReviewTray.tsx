import type { ScopedThreadRef } from "@t3tools/contracts";
import { CornerDownLeftIcon, Undo2Icon } from "lucide-react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import { Button } from "../ui/button";

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

/** Undo removes this tray's surviving comments; dismissing keeps them in the composer. */
export function DiffReviewTray({
  composerDraftTarget,
  commentIds,
  onDismiss,
}: {
  composerDraftTarget: ScopedThreadRef | DraftId;
  commentIds: ReadonlyArray<string>;
  onDismiss: () => void;
}) {
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const liveIds = commentIds.filter((id) => reviewComments.some((comment) => comment.id === id));
  if (liveIds.length === 0) return null;

  return (
    <div className="shrink-0 px-2 pt-1.5 pb-2">
      <div
        role="status"
        className="flex flex-col gap-2.5 rounded-pane surface-panel py-3 pr-3 pl-4"
      >
        <p className="flex min-w-0 items-center gap-1.5 text-label text-foreground">
          <CornerDownLeftIcon aria-hidden className="size-3.5 shrink-0 text-ring" />
          <span className="truncate">
            {liveIds.length === 1
              ? "1 comment added to the composer"
              : `${liveIds.length} comments added to the composer`}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              for (const id of liveIds) removeReviewComment(composerDraftTarget, id);
              onDismiss();
            }}
          >
            <Undo2Icon />
            Undo
          </Button>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onDismiss}>
            Keep reviewing
          </Button>
        </div>
      </div>
    </div>
  );
}
