import { MousePointerClick, X } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type ElementContextDraft,
  formatElementContextLabel,
  formatElementContextSourceLabel,
} from "~/lib/elementContext";

interface ComposerPendingElementContextsProps {
  contexts: ReadonlyArray<ElementContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

interface ComposerPendingElementContextChipProps {
  context: ElementContextDraft;
  onRemove: (contextId: string) => void;
}

function buildTooltipContent(context: ElementContextDraft): string {
  const lines: string[] = [];
  lines.push(formatElementContextLabel(context));
  const source = formatElementContextSourceLabel(context);
  if (source) lines.push(source);
  if (context.pageUrl) lines.push(context.pageUrl);
  if (context.selector) lines.push(context.selector);
  if (context.htmlPreview.trim().length > 0) {
    lines.push("");
    lines.push(context.htmlPreview.trim().slice(0, 600));
  }
  return lines.join("\n");
}

export function ComposerPendingElementContextChip({
  context,
  onRemove,
}: ComposerPendingElementContextChipProps) {
  const label = formatElementContextLabel(context);
  const sourceLabel = formatElementContextSourceLabel(context);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "pr-1")}>
            <MousePointerClick className={cn(COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, "size-3.5")} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
            {sourceLabel ? (
              <span className="select-none text-[10px] font-normal leading-tight text-muted-foreground/85">
                {sourceLabel}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemove(context.id);
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {buildTooltipContent(context)}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerPendingElementContexts({
  contexts,
  onRemove,
  className,
}: ComposerPendingElementContextsProps) {
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingElementContextChip key={context.id} context={context} onRemove={onRemove} />
      ))}
    </div>
  );
}
