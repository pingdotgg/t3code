import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useState, type Ref } from "react";
import { textDirection } from "~/textDirection";

import { Button } from "../ui/button";

export function AssistantCitationCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
}: {
  citation: AssistantCitation;
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

  const ASSISTANTCITATIONMAXCOMMENTLENGTHToLocaleStringText = commentTooLong
    ? ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()
    : undefined;
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
        aria-label={t({ message: "Comment on selected text" })}
        aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        aria-invalid={commentTooLong || undefined}
        placeholder={t({ message: "Add an optional comment..." })}
        rows={2}
        dir={textDirection(comment)}
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
          <Trans>
            Comments can contain up to {ASSISTANTCITATIONMAXCOMMENTLENGTHToLocaleStringText}{" "}
            characters.
          </Trans>
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          size="xs"
          disabled={commentTooLong}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? <Trans>Shorten comment</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </div>
  );
}
