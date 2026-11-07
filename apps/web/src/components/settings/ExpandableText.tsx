import { InlineButton } from "../ui/button";
import { useId, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";

export function ExpandableText({
  text,
  collapsedText = text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: {
  text: string;
  collapsedText?: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const canExpand = expanded || clipped || collapsedText !== text;

  return (
    <div className={cn("min-w-0", className)}>
      <div
        // A new text can be clipped at the same box size, which a resize alone would not report.
        key={collapsedText}
        ref={(element) => {
          // Expanded text is unclamped, so measuring it would drop the button and its focus.
          if (element === null || expanded) return;
          const measure = () => setClipped(element.scrollHeight - element.clientHeight > 1);
          const stopObserving = observeResize(element, measure);
          // A font swap can rewrap the text without resizing the clamped box.
          document.fonts.addEventListener("loadingdone", measure);
          return () => {
            stopObserving();
            document.fonts.removeEventListener("loadingdone", measure);
          };
        }}
        id={textId}
        className={cn("whitespace-pre-wrap break-words", !expanded && collapsedClassName)}
      >
        {expanded ? text : collapsedText}
      </div>
      {canExpand ? (
        <InlineButton
          aria-expanded={expanded}
          aria-controls={textId}
          tone="muted"
          className="mt-1"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : expandLabel}
        </InlineButton>
      ) : null}
    </div>
  );
}
