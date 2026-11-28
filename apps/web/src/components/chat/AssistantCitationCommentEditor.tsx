import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  use,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

import { ComposerContextActionsContext } from "../composerContextActions";
import { Button } from "../ui/button";

/** Lets the popover finish a running dictation, instead of discarding it, when it is dismissed. */
export type AssistantCitationCommentDictation = {
  /** False when nothing is being dictated; otherwise `settle` gets the comment once it is transcribed. */
  finish: (settle: (comment: string) => void) => boolean;
};

export function AssistantCitationCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
  onVoiceSetupOpenChange,
  dictationRef,
}: {
  citation: AssistantCitation;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
  onVoiceSetupOpenChange?: (open: boolean) => void;
  dictationRef?: Ref<AssistantCitationCommentDictation>;
}) {
  const gt = useGT();
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
  useImperativeHandle(dictationRef, () => ({
    finish: (settle) => {
      if (!speech.blocksSubmission || speech.preparing) return false;
      speech.submitAfterDictation(settle);
      return true;
    },
  }));
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
      <textarea
        ref={textareaRef}
        readOnly={speech.freezesEditor}
        aria-label={gt("Comment on selected text")}
        aria-description={gt(
          "Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line.",
        )}
        aria-invalid={commentTooLong || undefined}
        placeholder={gt("Add an optional comment...")}
        rows={2}
        dir={textDirection(comment)}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-body outline-none text-foreground placeholder:text-muted-foreground max-sm:text-base"
        value={speech.displayText}
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
      {commentTooLong ? (
        <p role="status" className="pt-1 text-meta text-error-foreground">
          <T>
            Comments can contain up to{" "}
            <Var>{ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}</Var> characters.
          </T>
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} />
        {/* Wrap as a pair so the recording pill never pushes Save alone onto a new row under Cancel. */}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="xs"
            // Escape cancels; keep Tab from the comment on Save so Enter cannot discard a new citation.
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onCancel}
          >
            <T>Cancel</T>
          </Button>
          <Button
            size="xs"
            disabled={speech.preparing || (commentTooLong && !speech.blocksSubmission)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={submit}
          >
            {commentTooLong
              ? gt("Shorten comment")
              : gt("Save", { $context: "verb, saves the comment" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
