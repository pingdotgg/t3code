import { useEffect, useId, useRef, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

/** Keep the complete markdown intact while limiting long reports to a readable preview. */
export function PullRequestCommentBody({
  className,
  ...props
}: ComponentProps<typeof PullRequestMarkdown>) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.getBoundingClientRect().height > 240);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={cn("min-w-0", className)}>
      <div
        id={id}
        className={cn("relative", !expanded && "max-h-[240px] overflow-hidden")}
        onFocusCapture={() => setExpanded(true)}
      >
        <div ref={content}>
          <PullRequestMarkdown {...props} />
        </div>
        {overflowing && !expanded ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
          />
        ) : null}
      </div>
      {overflowing ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="mt-2"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            if (expanded) content.current?.parentElement?.scrollIntoView({ block: "nearest" });
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show full comment"}
        </Button>
      ) : null}
    </div>
  );
}
