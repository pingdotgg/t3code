import type { EnvironmentId } from "@t3tools/contracts";
import {
  SpeechTextField,
  TextFieldSpeechControls,
  type useTextFieldSpeech,
} from "~/speech/useTextFieldSpeech";

import { Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { textDirection } from "~/textDirection";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatElapsedDurationLabel } from "~/timestampFormat";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly allowEmpty?: boolean;
  readonly onAction: (text: string) => void;
}

interface DiffCommentAnnotationProps {
  environmentId?: EnvironmentId;
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
  /** When a saved comment was written, shown beside the author as a relative time. */
  createdAt?: string | undefined;
  /** Where the comment lives now, such as "In composer", as a chip at the end of the head. */
  stateLabel?: string | undefined;
}

/** Comments written here are the reader's own; there is no other author to name. */
const LOCAL_AUTHOR = "You";

/** A relative time that moves on by itself, once a minute, instead of freezing at "just now". */
function RelativeCommentTime({ createdAt }: { createdAt: string }) {
  const now = useNowMinute();
  return <span className="shrink-0">{formatElapsedDurationLabel(createdAt, Date.parse(now))}</span>;
}

/** Avatar, author, then a range or time, and the comment's state at the far end. */
export function CommentCardHead({
  meta,
  stateLabel,
  action,
}: {
  meta?: ReactNode;
  stateLabel?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-merged text-micro leading-none text-white"
      >
        {LOCAL_AUTHOR.charAt(0)}
      </span>
      <span className="shrink-0 text-meta text-foreground">{LOCAL_AUTHOR}</span>
      {meta ? (
        <span className="min-w-0 truncate text-caption text-dim-foreground">{meta}</span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {action}
        {typeof stateLabel === "string" ? (
          <Badge variant="secondary">{stateLabel}</Badge>
        ) : (
          stateLabel
        )}
      </span>
    </div>
  );
}

/**
 * The raised card every inline comment shares: the popover fill and shadow, with a masked rim.
 * Callers set `--surface-tint-rim` to pick the rim.
 */
export const COMMENT_CARD_CLASS =
  "relative min-w-0 rounded-card bg-linear-to-b from-(--popover-top) to-(--popover-bottom) font-sans text-foreground shadow-(--popover-shadow) before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:surface-tint-rim";

export function DiffCommentAnnotation({
  environmentId,
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
  createdAt,
  stateLabel,
}: DiffCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  const displayedText = kind === "draft" && !onTextChange ? localDraftText : text;
  const trimmedText = displayedText.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the draft textarea on the next animation frame after mount
  useLayoutEffect(() => {
    if (kind !== "draft" || !focusOnMount) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnMount, kind]);

  if (kind === "comment") {
    return (
      <div
        data-diff-comment-annotation
        className={`group/comment ${COMMENT_CARD_CLASS} selection:bg-primary selection:text-primary-foreground [--surface-tint-rim:var(--popover-rim)]`}
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="px-2.5 pt-2">
          <CommentCardHead
            meta={createdAt ? <RelativeCommentTime createdAt={createdAt} /> : rangeLabel}
            stateLabel={stateLabel}
            action={
              onDelete ? (
                <span className="flex opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label="Delete comment"
                    onClick={onDelete}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </span>
              ) : null
            }
          />
        </div>
        <p
          dir={textDirection(displayedText)}
          className="min-w-0 px-2.5 pt-1.5 pb-2.5 whitespace-pre-wrap text-body leading-5"
        >
          {displayedText}
        </p>
      </div>
    );
  }

  // Pierre hides native carets and selection; textarea comments need their own visible feedback.
  const renderDraft = (speech?: ReturnType<typeof useTextFieldSpeech>) => (
    <div
      data-diff-comment-annotation
      className={`flex flex-col gap-2 p-2.5 ${COMMENT_CARD_CLASS} caret-foreground selection:bg-primary selection:text-primary-foreground [--surface-tint-rim:var(--diff-comment-rim,var(--popover-rim))]`}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CommentCardHead meta={rangeLabel} stateLabel={stateLabel} />
      <Textarea
        ref={textareaRef}
        readOnly={speech?.freezesEditor}
        autoFocus={focusOnMount}
        size="sm"
        value={displayedText}
        dir={textDirection(displayedText)}
        placeholder={placeholder}
        aria-label={`Comment on lines ${rangeLabel}`}
        onChange={(event) => (onTextChange ?? setLocalDraftText)(event.target.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (
            isCommentSubmitShortcut(
              event,
              trimmedText,
              pending || speech?.blocksSubmission === true,
            )
          ) {
            event.preventDefault();
            onComment(trimmedText);
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-auto text-micro text-dim-foreground">⌘/Ctrl Enter to send</span>
        {speech ? <TextFieldSpeechControls speech={speech} disabled={pending} /> : null}
        <Button variant="ghost-muted" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={
              pending || speech?.blocksSubmission || (!secondaryAction.allowEmpty && !trimmedText)
            }
            onClick={() => secondaryAction.onAction(trimmedText)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={pending || speech?.blocksSubmission || !trimmedText}
          onClick={() => onComment(trimmedText)}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
  return environmentId ? (
    <SpeechTextField
      environmentId={environmentId}
      ownerKey={ownerKey ?? rangeLabel}
      text={displayedText}
      textareaRef={textareaRef}
      onTextChange={onTextChange ?? setLocalDraftText}
      disabled={pending}
    >
      {renderDraft}
    </SpeechTextField>
  ) : (
    renderDraft()
  );
}
