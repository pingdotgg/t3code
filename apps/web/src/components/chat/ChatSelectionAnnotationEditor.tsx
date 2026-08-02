import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChatSelectionAnnotation } from "~/chatSelectionAnnotation";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

interface ChatSelectionAnnotationEditorProps {
  annotation: ChatSelectionAnnotation;
  anchorRect: { top: number; left: number; width: number; height: number };
  onCancel: () => void;
  onDelete: () => void;
  onSave: (comment: string) => void;
}

function editorPosition(anchorRect: ChatSelectionAnnotationEditorProps["anchorRect"]) {
  const width = Math.min(320, window.innerWidth - 32);
  const rightSideLeft = anchorRect.left + anchorRect.width + 12;
  const left =
    rightSideLeft + width <= window.innerWidth - 16
      ? rightSideLeft
      : Math.max(16, anchorRect.left - width - 12);

  return {
    left,
    top: Math.max(16, Math.min(window.innerHeight - 176, anchorRect.top - 24)),
    width,
  };
}

export function ChatSelectionAnnotationEditor({
  annotation,
  anchorRect,
  onCancel,
  onDelete,
  onSave,
}: ChatSelectionAnnotationEditorProps) {
  const [comment, setComment] = useState(annotation.comment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setComment(annotation.comment);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [annotation.comment, annotation.id]);

  return createPortal(
    <form
      aria-label={`Edit annotation ${annotation.id}`}
      className="fixed z-[72] rounded-2xl border border-border/80 bg-popover p-3 shadow-xl"
      data-chat-selection-popover="true"
      style={editorPosition(anchorRect)}
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(comment.trim());
      }}
    >
      <Textarea
        ref={textareaRef}
        unstyled
        value={comment}
        aria-label="Annotation comment"
        placeholder="Add an optional comment..."
        className="block min-h-20 w-full resize-none bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete annotation"
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Save
          </Button>
        </div>
      </div>
    </form>,
    document.body,
  );
}
