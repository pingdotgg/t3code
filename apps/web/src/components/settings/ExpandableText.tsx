import { InlineButton } from "../ui/button";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
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
  const textRef = useRef<HTMLDivElement>(null);
  // Both are keyed to the text they were decided for, so a new text starts collapsed and unmeasured.
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const [clampedText, setClampedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  const hasHiddenText = collapsedText !== text;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only the laid-out DOM knows whether the clamp hides a line; refit on resize
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded || hasHiddenText) return;
    const measure = () =>
      setClampedText(element.scrollHeight > element.clientHeight ? collapsedText : null);
    measure();
    return observeResize(element, measure);
  }, [expanded, hasHiddenText, collapsedText]);
  const canExpand = hasHiddenText || clampedText === collapsedText;

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={textRef}
        id={textId}
        className={cn("whitespace-pre-wrap break-words", !expanded ? collapsedClassName : null)}
      >
        {expanded ? text : collapsedText}
      </div>
      {canExpand ? (
        <InlineButton
          aria-expanded={expanded}
          aria-controls={textId}
          tone="muted"
          className="mt-1"
          onClick={() => setExpandedText(expanded ? null : text)}
        >
          {expanded ? "Show less" : expandLabel}
        </InlineButton>
      ) : null}
    </div>
  );
}
