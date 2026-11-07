import {
  aiReviewerDisplayBody,
  parseAiReviewerFeedback,
} from "@t3tools/client-runtime/ai-reviewer-feedback";
import { useId, useRef, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { Button } from "../ui/button";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { visibleBody } from "./pullRequestDetail.logic";

export function PullRequestCommentBody({
  className,
  text,
  ...props
}: ComponentProps<typeof PullRequestMarkdown>) {
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const id = useId();
  const feedback = parseAiReviewerFeedback(text);
  const compact = feedback === null ? null : aiReviewerDisplayBody(feedback);
  const original = visibleBody(text) ?? text;
  const rendered = showOriginal || compact === null ? original : compact;
  const optimized = compact !== null;

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={clip}
        id={id}
        className={cn("relative", !expanded && "max-h-[240px] overflow-hidden")}
        onFocusCapture={() => setExpanded(true)}
      >
        <div
          ref={(element) => {
            if (element === null) return;
            return observeResize(element, ([entry]) => {
              if (entry) setOverflowing(entry.contentRect.height > 240);
            });
          }}
        >
          <PullRequestMarkdown {...props} text={rendered} />
        </div>
        {overflowing && !expanded ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          />
        ) : null}
      </div>
      {overflowing || optimized ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {overflowing ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => {
                if (expanded) clip.current?.scrollIntoView({ block: "nearest" });
                setExpanded(!expanded);
              }}
            >
              {expanded ? "Show less" : "Show full comment"}
            </Button>
          ) : null}
          {optimized ? (
            <Button
              size="xs"
              variant="ghost-muted"
              aria-pressed={showOriginal}
              onClick={() => {
                setShowOriginal((current) => !current);
                setExpanded(true);
              }}
            >
              {showOriginal ? "Show summary" : "Show original"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
