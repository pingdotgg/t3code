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
          className="w-[min(22rem,calc(100vw-2rem))] border border-border/80 bg-background/95 shadow-lg"
          viewportClassName="p-1 [--viewport-inline-padding:--spacing(1)]"
        >
          <div>
            {annotations.map((annotation, index) => (
              <section
                key={annotation.id}
                className="relative border-b border-border/40 px-2.5 py-2.5 pr-8 last:border-b-0"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground/75">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Selected text</div>
                      <p className="mt-0.5 break-words text-sm leading-5 text-foreground/90">
                        {annotation.selectedText}
                      </p>
                    </div>
                    {annotation.comment.trim() ? (
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">Comment</div>
                        <p className="mt-0.5 break-words text-sm leading-5 text-foreground/90">
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
                    "absolute right-2 top-2 size-5",
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
