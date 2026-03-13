import { useEffect, useRef } from "react";
import { Button } from "./ui/button";

interface DiffContextCommentDraftProps {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  body: string;
  error: string;
  onBodyChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onDelete?: () => void;
  submitLabel?: string;
}

function formatLineRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

export const DIFF_CONTEXT_COMMENT_CARD_STYLE = {
  width: "min(44rem, calc(100cqw - 3.5rem), calc(100vw - 7.5rem))",
  maxWidth: "100%",
} as const;

export function DiffContextCommentDraft({
  filePath,
  lineStart,
  lineEnd,
  body,
  error,
  onBodyChange,
  onCancel,
  onSubmit,
  onDelete,
  submitLabel = "Comment",
}: DiffContextCommentDraftProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.focus();
    const cursorPosition = textarea.value.length;
    textarea.setSelectionRange(cursorPosition, cursorPosition);
  }, [filePath, lineStart, lineEnd]);

  return (
    <div
      className="ml-2 mr-5 my-1 min-w-0"
      style={DIFF_CONTEXT_COMMENT_CARD_STYLE}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="group rounded-md border border-border bg-card transition-colors duration-200 focus-within:border-ring/45">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }}
            placeholder="Request change"
            aria-label={`Comment on ${filePath}:${formatLineRange(lineStart, lineEnd)}`}
            className="min-h-[200px] w-full resize-none bg-transparent px-3 py-3 pb-15 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 sm:px-4 sm:py-4"
          />
          <div className="absolute right-4 bottom-3 left-4 z-10 flex flex-wrap items-end justify-between gap-3 sm:right-5 sm:left-5">
            <div className="min-w-0 flex-1 basis-40">
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {onDelete ? (
                <Button type="button" variant="destructive" onClick={onDelete}>
                  Delete
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="button" onClick={onSubmit}>
                {submitLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
