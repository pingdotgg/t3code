import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useState, type Ref } from "react";
import { textDirection } from "~/textDirection";

import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

export function AssistantCitationCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onViewSource,
  onDraftChange,
}: {
  citation: AssistantCitation;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  /** Escape closes the editor; there is no Cancel button. */
  onCancel: () => void;
  onViewSource?: () => void;
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
    <div
      data-citation-comment-editor="true"
      className="flex flex-col gap-2.5"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <blockquote
        dir={textDirection(citation.text)}
        className="line-clamp-4 border-l-2 border-border pl-2.5 text-sm/[1.45] whitespace-pre-wrap text-muted-foreground"
      >
        {citation.text}
      </blockquote>
      <div className="rounded-control surface-well px-2.5 py-2 focus-within:surface-focus">
        <textarea
          ref={inputRef}
          aria-label="Comment on selected text"
          aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
          aria-invalid={commentTooLong || undefined}
          placeholder="Add an optional comment..."
          rows={2}
          dir={textDirection(comment)}
          className="field-sizing-content block max-h-40 min-h-10 w-full resize-none bg-transparent text-base/normal outline-none text-foreground placeholder:text-placeholder sm:text-sm/normal"
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
      </div>
      {commentTooLong ? (
        <p role="status" className="-mt-1 text-meta text-error-foreground">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {onViewSource ? (
          <Button
            variant="secondary"
            size="xs"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onViewSource}
          >
            View source
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={commentTooLong}
          aria-keyshortcuts="Enter"
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : "Save"}
          {commentTooLong ? null : <Kbd aria-hidden="true">⏎</Kbd>}
        </Button>
      </div>
    </div>
  );
}
