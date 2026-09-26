import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH } from "@t3tools/contracts";
import { useState, type Ref } from "react";

import { Button } from "../ui/button";

/** The comment field shared by text and image citations. Enter submits; Escape cancels. */
export function CitationCommentEditor({
  initialComment = "",
  label,
  description,
  submitLabel,
  submitDisabled = false,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
}: {
  initialComment?: string;
  label: string;
  description: string;
  submitLabel: string;
  /** Holds submission while the owner finishes the previous one. */
  submitDisabled?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => void;
  onSubmitAndSend?: (comment: string) => void;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const [comment, setComment] = useState(initialComment);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const blocked = commentTooLong || submitDisabled;
  const submit = () => {
    if (!blocked) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (blocked) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };

  return (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <textarea
        ref={inputRef}
        aria-label={label}
        aria-description={description}
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
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
          disabled={blocked}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
