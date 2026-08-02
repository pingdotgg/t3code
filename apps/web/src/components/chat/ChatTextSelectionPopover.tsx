import { Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ChatTextSelectionPopoverProps {
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  avoidRects: ReadonlyArray<{
    top: number;
    left: number;
    width: number;
    height: number;
  }>;
  onAddAnnotation: (comment: string) => void;
  onClose: () => void;
}

function overlapArea(
  first: { top: number; left: number; width: number; height: number },
  second: { top: number; left: number; width: number; height: number },
) {
  const width = Math.max(
    0,
    Math.min(first.left + first.width, second.left + second.width) -
      Math.max(first.left, second.left),
  );
  const height = Math.max(
    0,
    Math.min(first.top + first.height, second.top + second.height) -
      Math.max(first.top, second.top),
  );
  return width * height;
}

function popoverPosition(
  rect: ChatTextSelectionPopoverProps["rect"],
  avoidRects: ChatTextSelectionPopoverProps["avoidRects"],
  mode: "actions" | "comment",
) {
  if (mode === "comment") {
    const edgeGap = 16;
    const anchorGap = 12;
    const height = 44;
    const maxWidth = Math.min(320, Math.max(0, window.innerWidth - edgeGap * 2));
    const minWidth = Math.min(220, maxWidth);
    const rightLeft = rect.left + rect.width + anchorGap;
    const rightAvailable = window.innerWidth - edgeGap - rightLeft;
    const leftRight = rect.left - anchorGap;
    const leftAvailable = leftRight - edgeGap;
    const useRightSide = rightAvailable >= minWidth || rightAvailable >= leftAvailable;
    const availableWidth = useRightSide ? rightAvailable : leftAvailable;
    const width = Math.max(minWidth, Math.min(maxWidth, availableWidth));
    const left = useRightSide ? rightLeft : Math.max(edgeGap, leftRight - width);
    const clampTop = (top: number) => Math.max(16, Math.min(window.innerHeight - height - 16, top));
    const centeredTop = rect.top + rect.height / 2 - height / 2;
    const candidateTops = [
      centeredTop,
      rect.top + rect.height + anchorGap,
      rect.top - height - anchorGap,
      ...avoidRects.flatMap((avoidRect) => [
        avoidRect.top + avoidRect.height + anchorGap,
        avoidRect.top - height - anchorGap,
      ]),
    ];
    const candidates = [...new Set(candidateTops.map(clampTop))].map((top, preference) => ({
      left,
      top,
      width,
      height,
      preference,
    }));
    const best = candidates.reduce((current, candidate) => {
      const score = avoidRects.reduce(
        (total, avoidRect) => total + overlapArea(candidate, avoidRect),
        0,
      );
      const currentScore = avoidRects.reduce(
        (total, avoidRect) => total + overlapArea(current, avoidRect),
        0,
      );
      if (score === currentScore) {
        const distance = Math.abs(candidate.top - centeredTop);
        const currentDistance = Math.abs(current.top - centeredTop);
        if (distance === currentDistance) {
          return candidate.preference < current.preference ? candidate : current;
        }
        return distance < currentDistance ? candidate : current;
      }
      return score < currentScore ? candidate : current;
    });
    return { left: best.left, top: best.top, width: best.width };
  }

  const center = rect.left + rect.width / 2;
  const preferAbove = rect.top > 96;
  return {
    left: Math.max(12, Math.min(window.innerWidth - 12, center)),
    ...(preferAbove
      ? { top: Math.max(12, rect.top - 8), transform: "translate(-50%, -100%)" }
      : { top: rect.top + rect.height + 8, transform: "translateX(-50%)" }),
  };
}

export function ChatTextSelectionPopover({
  rect,
  avoidRects,
  onAddAnnotation,
  onClose,
}: ChatTextSelectionPopoverProps) {
  const [isAddingComment, setIsAddingComment] = useState(false);
  const [comment, setComment] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const position = popoverPosition(rect, avoidRects, isAddingComment ? "comment" : "actions");

  useEffect(() => {
    if (!isAddingComment) return;
    inputRef.current?.focus();
  }, [isAddingComment]);

  const submitAnnotation = () => {
    onAddAnnotation(comment.trim());
    setComment("");
  };

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      style={position}
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
            submitAnnotation();
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
          <Button
            type="submit"
            size="icon"
            aria-label="Add text annotation"
            className="rounded-full"
          >
            <Check className="size-4" aria-hidden />
          </Button>
        </form>
      ) : (
        <div className="flex items-center overflow-hidden rounded-xl border border-border/80 bg-popover p-0.5 shadow-lg">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("border-0 shadow-none")}
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
