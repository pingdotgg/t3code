import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { MessageCircle, Trash2 } from "lucide-react";
import { useLayoutEffect, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "~/components/pullRequest/PullRequestMarkdownTextarea";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type TextFieldSpeech,
} from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";
import { isMacPlatform } from "~/lib/utils";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly allowEmpty?: boolean;
  readonly onAction: (text: string) => void;
}

interface DiffCommentAnnotationProps {
  /** With an environment, the draft can be dictated; its project supplies vocabulary. */
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  ownerKey?: string;
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onTextChange?: (text: string) => void;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete?: () => void;
  placeholder?: string;
  submitLabel?: string;
  pending?: boolean;
  secondaryAction?: DiffCommentSecondaryAction;
  focusOnMount?: boolean;
  /** Set only for pull request comments, where `@` completes the repository's users. */
  completionScope?: PullRequestCompletionScope | null;
  renderAttachments?:
    | ((
        onTextChange: (text: string) => void,
        onBusyChange: (busy: boolean) => void,
        textarea: HTMLTextAreaElement | null,
      ) => ReactNode)
    | undefined;
}

export function DiffCommentAnnotation({
  environmentId,
  projectId,
  ownerKey,
  kind,
  rangeLabel,
  text,
  onTextChange,
  onCancel,
  onComment,
  onDelete,
  placeholder = "Add a comment…",
  submitLabel = "Comment",
  pending = false,
  secondaryAction,
  focusOnMount = true,
  completionScope = null,
  renderAttachments,
}: DiffCommentAnnotationProps) {
  const [uploading, setUploading] = useState(false);
  const blocked = pending || uploading;
  const [localDraftText, setLocalDraftText] = useState("");
  const displayedText = kind === "draft" && !onTextChange ? localDraftText : text;
  const trimmedText = displayedText.trim();
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const modifierKey = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the draft textarea on the next animation frame after mount
  useLayoutEffect(() => {
    if (kind !== "draft" || !focusOnMount) return;
    const frame = window.requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnMount, kind, textarea]);

  if (kind === "comment") {
    return (
      <div
        data-diff-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground selection:bg-primary selection:text-primary-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="size-3.5 h-5 shrink-0 text-primary/70" aria-hidden="true" />
        <p
          className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5"
          dir={textDirection(displayedText)}
        >
          {displayedText}
        </p>
        {onDelete ? (
          <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Delete comment"
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        ) : null}
      </div>
    );
  }

  const submit = (
    speech: TextFieldSpeech | undefined,
    action: (text: string) => void,
    allowEmpty = false,
  ) => {
    const finish = (value: string) => {
      if (!blocked && (allowEmpty || value.trim())) action(value.trim());
    };
    if (speech) speech.submitAfterDictation(finish);
    else finish(displayedText);
  };

  // Pierre hides native carets and selection; textarea comments need their own visible feedback.
  const renderDraft = (speech?: TextFieldSpeech) => (
    <div
      data-diff-comment-annotation
      data-review-attachment-composer
      className="px-3 py-2 font-sans text-foreground caret-foreground selection:bg-primary selection:text-primary-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <PullRequestMarkdownTextarea
        ref={setTextarea}
        completionScope={completionScope}
        readOnly={speech?.freezesEditor}
        autoFocus={focusOnMount}
        size="sm"
        disabled={blocked}
        value={displayedText}
        dir={textDirection(displayedText)}
        placeholder={placeholder}
        aria-label={`Comment on lines ${rangeLabel}`}
        onValueChange={onTextChange ?? setLocalDraftText}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !blocked) {
            event.preventDefault();
            if (speech && speech.state.phase !== "idle") speech.cancel();
            else onCancel();
          }
          if (isCommentSubmitShortcut(event, trimmedText, blocked, speech?.blocksSubmission)) {
            event.preventDefault();
            submit(
              speech,
              event.shiftKey && secondaryAction ? secondaryAction.onAction : onComment,
            );
          }
        }}
      />
      {renderAttachments?.(onTextChange ?? setLocalDraftText, setUploading, textarea)}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="mr-auto flex flex-col text-3xs text-muted-foreground/70">
          <span>
            {modifierKey}+Enter to {submitLabel.toLowerCase()}
          </span>
          {secondaryAction ? (
            <span>
              {modifierKey}+Shift+Enter to {secondaryAction.label.toLowerCase()}
            </span>
          ) : null}
        </span>
        {speech ? <TextFieldSpeechControls speech={speech} disabled={blocked} /> : null}
        <Button variant="ghost-muted" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="outline"
            disabled={
              speech?.preparing ||
              blocked ||
              (!speech?.blocksSubmission && !secondaryAction.allowEmpty && !trimmedText)
            }
            onClick={() => submit(speech, secondaryAction.onAction, secondaryAction.allowEmpty)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={speech?.preparing || blocked || (!speech?.blocksSubmission && !trimmedText)}
          onClick={() => submit(speech, onComment)}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );

  return environmentId ? (
    <SpeechTextField
      environmentId={environmentId}
      projectId={projectId}
      ownerKey={ownerKey ?? rangeLabel}
      text={displayedText}
      textareaRef={{ current: textarea }}
      onTextChange={onTextChange ?? setLocalDraftText}
      disabled={blocked}
    >
      {renderDraft}
    </SpeechTextField>
  ) : (
    renderDraft()
  );
}
