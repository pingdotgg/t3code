import { InlineButton } from "../ui/button";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "../../lib/utils";

interface ExpandableTextProps {
  text: string;
  collapsedText?: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}

// Keyed by the text, so a replaced error starts collapsed and is measured afresh.
export function ExpandableText(props: ExpandableTextProps) {
  return <ExpandableTextBody key={props.text} {...props} />;
}

function ExpandableTextBody({
  text,
  collapsedText = text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: ExpandableTextProps) {
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const hasHiddenText = collapsedText !== text;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only the laid-out DOM knows whether the clamp hides a line; refit on resize
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded || hasHiddenText) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight);
    measure();
    return observeResize(element, measure);
  }, [expanded, hasHiddenText]);
  const canExpand = hasHiddenText || clamped;

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
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : expandLabel}
        </InlineButton>
      ) : null}
    </div>
  );
}
