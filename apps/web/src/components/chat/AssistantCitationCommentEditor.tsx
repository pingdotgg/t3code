import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useState, type Ref } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export function AssistantCitationCommentEditor({
  citation,
  inline = false,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
}: {
  citation: AssistantCitation;
  /** Reads as the comment text under the quote: no box, no buttons. Keys and dismissal still save. */
  inline?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (commentTooLong) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };

  return (
    <div>
      <textarea
        ref={inputRef}
        aria-label="Comment on selected text"
        aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={inline ? 1 : 2}
        className={cn(
          "field-sizing-content block max-h-40 w-full resize-none bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm",
          inline ? "p-0" : "min-h-16 px-1 py-1.5",
        )}
        value={comment}
        onChange={(event) => {
          setComment(event.currentTarget.value);
          onDraftChange?.(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              submitAndSend();
            } else {
              submit();
            }
          }
        }}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      {inline ? null : (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="xs"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={commentTooLong}
            onPointerDown={(event) => event.preventDefault()}
            onClick={submit}
          >
            {commentTooLong ? "Shorten comment" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
