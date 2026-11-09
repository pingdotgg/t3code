import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { use, useEffect, useRef, useState, type RefObject } from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

import { ComposerContextActionsContext } from "../composerContextActions";
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
  onVoiceSetupOpenChange,
}: {
  citation: AssistantCitation;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  /** Escape closes the editor; there is no Cancel button. */
  onCancel: () => void;
  onViewSource?: () => void;
  onDraftChange?: (comment: string) => void;
  onVoiceSetupOpenChange?: (open: boolean) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? localInputRef;
  const { environmentId, projectId } = use(ComposerContextActionsContext);
  const updateComment = (text: string) => {
    setComment(text);
    onDraftChange?.(text);
  };
  const speech = useTextFieldSpeech({
    environmentId: environmentId ?? citation.environmentId,
    projectId,
    ownerKey: JSON.stringify([
      "citation",
      environmentId,
      citation.threadId,
      citation.messageId,
      citation.start,
      citation.end,
    ]),
    text: comment,
    textareaRef,
    onTextChange: updateComment,
  });
  const setupOpen = speech.setup.open;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the citation popover open while the voice setup dialog owns focus
  useEffect(() => {
    onVoiceSetupOpenChange?.(setupOpen);
    return () => onVoiceSetupOpenChange?.(false);
  }, [onVoiceSetupOpenChange, setupOpen]);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) onSubmit(text);
    });
  };
  const submitAndSend = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) (onSubmitAndSend ?? onSubmit)(text);
    });
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
          if (speech.state.phase !== "idle") speech.cancel();
          else onCancel();
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
          ref={textareaRef}
          readOnly={speech.freezesEditor}
          aria-label="Comment on selected text"
          aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
          aria-invalid={commentTooLong || undefined}
          placeholder="Add an optional comment..."
          rows={2}
          dir={textDirection(comment)}
          className="field-sizing-content block max-h-40 min-h-10 w-full resize-none bg-transparent text-base/normal outline-none text-foreground placeholder:text-placeholder sm:text-sm/normal"
          value={comment}
          onChange={(event) => updateComment(event.currentTarget.value)}
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div
          className={
            speech.state.phase === "idle"
              ? "contents"
              : "flex basis-full flex-wrap gap-2 *:min-w-0 *:grow **:data-[slot=voice-input-pill]:w-full"
          }
        >
          <TextFieldSpeechControls speech={speech} />
        </div>
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
          disabled={speech.preparing || (commentTooLong && !speech.blocksSubmission)}
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
