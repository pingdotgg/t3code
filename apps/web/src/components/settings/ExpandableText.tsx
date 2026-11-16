import { msg, useMessages } from "gt-react";
import { InlineButton } from "../ui/button";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";

const EXPANDABLE_TEXT_MESSAGES = {
  "Show full error": msg("Show full error"),
  "Show full message": msg("Show full message"),
  "Show less": msg("Show less"),
} as const;

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
  const m = useMessages();
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const canExpand = collapsedText !== text || text.length > 180 || text.includes("\n");

  return (
    <div className={cn("min-w-0", className)}>
      <div
        id={textId}
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && canExpand ? collapsedClassName : null,
        )}
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
          {expanded
            ? m(EXPANDABLE_TEXT_MESSAGES["Show less"])
            : m(
                EXPANDABLE_TEXT_MESSAGES[expandLabel as keyof typeof EXPANDABLE_TEXT_MESSAGES] ??
                  msg(expandLabel),
              )}
        </InlineButton>
      ) : null}
    </div>
  );
}
