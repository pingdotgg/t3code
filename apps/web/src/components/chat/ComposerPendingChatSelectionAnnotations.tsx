import { TextQuote, X } from "lucide-react";

import type { ChatSelectionAnnotation } from "~/chatSelectionAnnotation";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";

interface ComposerPendingChatSelectionAnnotationsProps {
  annotations: ReadonlyArray<ChatSelectionAnnotation>;
  onRemove: (annotationId: string) => void;
  className?: string;
  compact?: boolean;
}

export function ComposerPendingChatSelectionAnnotations({
  annotations,
  onRemove,
  className,
  compact = false,
}: ComposerPendingChatSelectionAnnotationsProps) {
  if (annotations.length === 0) return null;
  const label = compact
    ? `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`
    : `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`;

  return (
    <div className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      <Popover>
        <div className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={label}
                className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm bg-transparent py-0.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            }
          >
            <TextQuote className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
              {compact ? `${annotations.length} selected` : label}
            </span>
          </PopoverTrigger>
          {annotations.length === 1 ? (
            <button
              type="button"
              aria-label="Remove text annotation"
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(annotations[0]!.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
        <PopoverPopup
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(15rem,calc(100vw-2rem))] border border-border/80 bg-background/72"
          viewportClassName="p-0.5 [--viewport-inline-padding:--spacing(0.5)]"
        >
          <div className="space-y-0.5">
            {annotations.map((annotation, index) => (
              <section
                key={annotation.id}
                className="relative border-b border-border/30 px-1.5 py-1 pr-6 last:border-b-0"
              >
                <div className="flex min-w-0 items-start gap-1.5 text-xs">
                  <span className="shrink-0 tabular-nums text-muted-foreground/75">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex min-w-0 items-start gap-1.5">
                      <span className="shrink-0 text-muted-foreground">Selected:</span>
                      <span className="min-w-0 break-words text-muted-foreground/90">
                        {annotation.selectedText}
                      </span>
                    </div>
                    {annotation.comment.trim() ? (
                      <div className="flex min-w-0 items-start gap-1.5">
                        <span className="shrink-0 text-muted-foreground">Comment:</span>
                        <p className="min-w-0 break-words text-muted-foreground/90">
                          {annotation.comment}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove text annotation ${index + 1}`}
                  className={cn(
                    COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
                    "absolute right-1 top-1 size-4",
                  )}
                  onClick={() => onRemove(annotation.id)}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </section>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
