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
          if (element === null) return;
          return observeResize(element, () => {
            setClipped(element.scrollHeight - element.clientHeight > 1);
          });
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
