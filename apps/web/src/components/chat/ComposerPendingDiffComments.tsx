import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  buildDiffContextCommentsPreviewTitle,
  type DiffContextCommentDraft,
} from "../../lib/diffContextComments";
import { DiffContextCommentsAttachment } from "./DiffContextCommentsAttachment";

export function ComposerPendingDiffComments(props: {
  comments: ReadonlyArray<DiffContextCommentDraft>;
  onClearAll: () => void;
}) {
  const { comments, onClearAll } = props;

  if (comments.length === 0) {
    return null;
  }

  const previewTitle = buildDiffContextCommentsPreviewTitle(comments);

  return (
    <DiffContextCommentsAttachment
      commentCount={comments.length}
      previewTitle={previewTitle}
      className="h-8 rounded-full pl-3 pr-1.5"
      action={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 rounded-full"
          aria-label="Clear pending diff comments"
          onClick={onClearAll}
        >
          <XIcon className="size-3" />
        </Button>
      }
    />
  );
}
