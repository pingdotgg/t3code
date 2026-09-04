import { MessageCircle, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly allowEmpty?: boolean;
  readonly onAction: (text: string) => void;
}

interface DiffCommentAnnotationProps {
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
}

/** The shared inline comment treatment for file previews, thread diffs, and pull-request diffs. */
export function DiffCommentAnnotation({
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
}: DiffCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  const displayedText = kind === "draft" && !onTextChange ? localDraftText : text;
  const trimmedText = displayedText.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-5">{displayedText}</p>
        {onDelete ? (
          <Button
            className="-my-1 -mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/comment:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
            variant="ghost"
            size="icon-xs"
            aria-label="Delete comment"
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-diff-comment-annotation
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={textareaRef}
        autoFocus={focusOnMount}
        unstyled
        className="relative inline-flex w-full rounded-md border border-border/50 bg-background/20 font-sans text-foreground transition-colors focus-within:border-border/70 [&_[data-slot=textarea]]:min-h-12 [&_[data-slot=textarea]]:cursor-text [&_[data-slot=textarea]]:caret-foreground [&_[data-slot=textarea]]:px-2.5 [&_[data-slot=textarea]]:py-1.5 [&_[data-slot=textarea]]:font-sans [&_[data-slot=textarea]]:text-xs [&_[data-slot=textarea]]:leading-5 max-sm:[&_[data-slot=textarea]]:min-h-12"
        size="sm"
        value={displayedText}
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
          if (isCommentSubmitShortcut(event, trimmedText, pending)) {
            event.preventDefault();
            onComment(trimmedText);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-[10px] text-muted-foreground/70">⌘/Ctrl Enter to send</span>
        <Button
          className="text-muted-foreground hover:text-foreground"
          variant="ghost"
          size="xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!secondaryAction.allowEmpty && !trimmedText}
            onClick={() => secondaryAction.onAction(trimmedText)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button size="xs" disabled={pending || !trimmedText} onClick={() => onComment(trimmedText)}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
