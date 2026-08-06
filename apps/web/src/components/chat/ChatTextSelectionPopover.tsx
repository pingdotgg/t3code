import { Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../ui/button";

export interface ChatTextSelectionPopoverProps {
  rect: { top: number; left: number; width: number; height: number };
  onAddAnnotation: (comment: string) => void;
  onCommentStateChange: (isAddingComment: boolean) => void;
  onClose: () => void;
}

function popoverPosition(rect: ChatTextSelectionPopoverProps["rect"], isAddingComment: boolean) {
  const viewportGap = 12;
  const popoverGap = 8;
  const estimatedPopoverHeight = isAddingComment ? 48 : 36;
  const width = isAddingComment ? Math.min(320, window.innerWidth - viewportGap * 2) : undefined;
  const halfWidth = width ? width / 2 : 60;
  const minimumCenter = viewportGap + halfWidth;
  const maximumCenter = window.innerWidth - viewportGap - halfWidth;
  const center =
    maximumCenter < minimumCenter
      ? window.innerWidth / 2
      : Math.max(minimumCenter, Math.min(maximumCenter, rect.left + rect.width / 2));
  const selectionBottom = rect.top + rect.height;
  const preferAbove =
    rect.top > 96 ||
    selectionBottom + popoverGap + estimatedPopoverHeight > window.innerHeight - viewportGap;
  const minimumTop = viewportGap + estimatedPopoverHeight;
  const maximumTop = Math.max(minimumTop, window.innerHeight - viewportGap);

  return {
    left: center,
    ...(preferAbove
      ? {
          top: Math.max(minimumTop, Math.min(maximumTop, rect.top - popoverGap)),
          transform: "translate(-50%, -100%)",
        }
      : {
          top: Math.max(
            viewportGap,
            Math.min(
              selectionBottom + popoverGap,
              window.innerHeight - viewportGap - estimatedPopoverHeight,
            ),
          ),
          transform: "translateX(-50%)",
        }),
    ...(width ? { width } : {}),
  };
}

export function ChatTextSelectionPopover({
  rect,
  onAddAnnotation,
  onCommentStateChange,
  onClose,
}: ChatTextSelectionPopoverProps) {
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [comment, setComment] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onCommentStateChange(isAddingComment);
    return () => onCommentStateChange(false);
  }, [isAddingComment, onCommentStateChange]);

  useEffect(() => {
    if (isAddingComment) inputRef.current?.focus();
  }, [isAddingComment]);

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={popoverPosition(rect, isAddingComment)}
      role="dialog"
      aria-label="Selected text actions"
      data-chat-selection-popover="true"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      {isAddingComment ? (
        <form
          className="flex w-full items-center gap-1.5 rounded-full border border-border/80 bg-popover px-2.5 py-1.5 shadow-lg"
          onSubmit={(event) => {
            event.preventDefault();
            onAddAnnotation(comment.trim());
          }}
        >
          <input
            ref={inputRef}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Add an optional comment..."
            aria-label="Optional comment for selected text"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="icon" aria-label="Add selected text" className="rounded-full">
            <Check className="size-4" aria-hidden />
          </Button>
        </form>
      ) : (
        <div className="flex items-center overflow-hidden rounded-xl border border-border/80 bg-popover p-0.5 shadow-lg">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setIsAddingComment(true)}
          >
            <Plus className="size-3.5" aria-hidden />
            Add to chat
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
}
