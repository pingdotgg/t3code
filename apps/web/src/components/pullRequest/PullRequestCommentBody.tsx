import { useId, useRef, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { observeResize } from "~/lib/observeResize";

/** Keep collapse within the comment's scroller, without moving the workspace canvas. */
function scrollCommentIntoView(element: HTMLElement) {
  let scroller = element.parentElement;
  while (scroller) {
    if (
      /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
      scroller.scrollHeight > scroller.clientHeight
    ) {
      const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (offset < 0) scroller.scrollTop += offset;
      return;
    }
    scroller = scroller.parentElement;
  }
}

export function PullRequestCommentBody({
  className,
  variant = "comment",
  ...props
}: ComponentProps<typeof PullRequestMarkdown> & { variant?: "comment" | "description" }) {
  const maxHeight = variant === "description" ? 64 : 240;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const id = useId();

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={clip}
        id={id}
        className={cn(
          "relative",
          !expanded && "overflow-hidden",
          !expanded && (variant === "description" ? "max-h-16" : "max-h-60"),
        )}
        onFocusCapture={() => setExpanded(true)}
      >
        <div
          ref={(element) => {
            if (element === null) return;
            return observeResize(element, ([entry]) => {
              if (entry) setOverflowing(entry.contentRect.height > maxHeight);
            });
          }}
        >
          <PullRequestMarkdown {...props} />
        </div>
        {overflowing && !expanded ? (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t to-transparent",
              variant === "description" ? "from-(--code-surface)" : "from-(--card-bottom)",
            )}
          />
        ) : null}
      </div>
      {overflowing ? (
        <div className="mt-1.5 text-meta">
          <InlineButton
            tone="muted"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => {
              if (expanded && clip.current) scrollCommentIntoView(clip.current);
              setExpanded(!expanded);
            }}
          >
            {expanded ? "Show less" : variant === "description" ? "Read more" : "Show full comment"}
          </InlineButton>
        </div>
      ) : null}
    </div>
  );
}
