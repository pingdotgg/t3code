import {
  aiReviewerDisplayBody,
  aiReviewerOneLine,
  parseAiReviewerFeedback,
} from "@t3tools/client-runtime/ai-reviewer-feedback";
import { ChevronRightIcon } from "lucide-react";
import { useId, useRef, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { visibleBody } from "./pullRequestDetail.logic";

export function PullRequestCommentBody({
  className,
  text,
  /** When false, AI findings render their compact body immediately (e.g. inside an already-expanded thread). */
  aiCollapsed = true,
  ...props
}: ComponentProps<typeof PullRequestMarkdown> & { aiCollapsed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clip = useRef<HTMLDivElement>(null);
  const id = useId();
  const feedback = parseAiReviewerFeedback(text);
  const compact = feedback === null ? null : aiReviewerDisplayBody(feedback);
  const oneLine = feedback === null ? null : aiReviewerOneLine(feedback);
  const original = visibleBody(text) ?? text;
  const optimized = compact !== null;
  const rendered = showOriginal || compact === null ? original : compact;

  if (aiCollapsed && oneLine !== null && !showOriginal) {
    return (
      <div className={cn("min-w-0", className)}>
        <Collapsible open={aiOpen} onOpenChange={setAiOpen}>
          <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-sm hover:bg-muted/50">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "-me-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                aiOpen && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{oneLine}</span>
          </CollapsibleTrigger>
          {/* Keep children mounted so CollapsiblePanel can animate height open and closed. */}
          <CollapsiblePanel>
            <div className="space-y-2 pt-2">
              <PullRequestMarkdown {...props} text={compact!} />
              <Button
                size="xs"
                variant="ghost-muted"
                aria-pressed={false}
                onClick={() => {
                  setShowOriginal(true);
                  setExpanded(true);
                }}
              >
                Show original
              </Button>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    );
  }

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
                if (showOriginal) setAiOpen(true);
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
