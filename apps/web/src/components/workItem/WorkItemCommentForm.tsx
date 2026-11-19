import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";

import { Button } from "../ui/button";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "../pullRequest/PullRequestMarkdownTextarea";
import { PullRequestSubmitKeyHint } from "../pullRequest/PullRequestSubmitKeyHint";

/** What the form hands a follow-up action beside Comment, such as Close with comment. */
export interface WorkItemCommentFormActions<Action extends string> {
  readonly submit: (action: Action) => void;
  readonly disabled: boolean;
  readonly submitting: Action | "comment" | null;
}

/**
 * A comment on a pull request or an issue: markdown with dictation, posted with the button or
 * the submit chord. `onSubmit` says whether the comment went, which clears the draft.
 */
export function WorkItemCommentForm<Action extends string = never>({
  environmentId,
  projectId,
  ownerKey,
  active,
  textareaRef,
  completionScope,
  label,
  placeholder,
  locked: lockedFromOutside = false,
  onSubmit,
  actions,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** Names the draft's dictation session; one per commented subject. */
  ownerKey: string;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  completionScope: PullRequestCompletionScope | null;
  label: string;
  placeholder: string;
  /** Held from outside, as while another action on the subject is under way. */
  locked?: boolean;
  onSubmit: (action: Action | "comment", text: string) => Promise<boolean>;
  actions?: (form: WorkItemCommentFormActions<Action>) => ReactNode;
}) {
  const gt = useGT();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState<Action | "comment" | null>(null);
  const locked = submitting !== null || lockedFromOutside;
  const speech = useTextFieldSpeech({
    environmentId,
    projectId,
    ownerKey,
    text: body,
    textareaRef,
    onTextChange: setBody,
    disabled: !active || locked,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);

  const submit = async (action: Action | "comment", text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || locked) return;
    setSubmitting(action);
    const posted = await onSubmit(action, trimmed);
    if (posted) setBody("");
    setSubmitting(null);
  };
  const submitAfterDictation = (action: Action | "comment") =>
    speech.submitAfterDictation((text) => void submit(action, text));
  const submitDisabled =
    speech.preparing || (body.trim().length === 0 && !speech.blocksSubmission) || locked;

  return (
    <div className="space-y-2">
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        // Lock while posting because success clears the draft.
        disabled={locked}
        readOnly={speech.freezesEditor}
        value={speech.displayText}
        rows={3}
        placeholder={placeholder}
        aria-label={label}
        onValueChange={setBody}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) submitAfterDictation("comment");
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} disabled={locked} />
        {actions?.({ submit: submitAfterDictation, disabled: submitDisabled, submitting })}
        <Button size="xs" disabled={submitDisabled} onClick={() => submitAfterDictation("comment")}>
          <SendIcon className="size-3.5" />
          {submitting === "comment"
            ? gt("Posting...")
            : gt("Comment", { $context: "verb, submit button" })}
          <PullRequestSubmitKeyHint />
        </Button>
      </div>
    </div>
  );
}
