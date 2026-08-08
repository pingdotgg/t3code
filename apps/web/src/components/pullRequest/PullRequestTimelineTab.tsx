import type { PullRequestDetail } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { buildPullRequestTimeline } from "./pullRequestDetail.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

/** How tall a body may stand before it is worth folding away. */
const COLLAPSED_BODY_HEIGHT = 96;

function TimelineBody({ body, markdown, cwd }: { body: string; markdown: boolean; cwd: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  /**
   * Measured rather than guessed from the text. A body's height depends on the width it is
   * given and on what the markdown turned into: a screenshot or a recording is a handful of
   * characters and half a screen tall, and a length heuristic would fold it away behind no
   * control at all. The body can change without this component unmounting, so both pieces of
   * presentation state are recalculated for the new content.
   */
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const measure = () => {
      setOverflows(content.getBoundingClientRect().height > COLLAPSED_BODY_HEIGHT);
    };
    setExpanded(false);
    setOverflows(false);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [body]);

  return (
    <div className="mt-1">
      <div
        className={cn(!expanded && "overflow-hidden")}
        style={expanded ? undefined : { maxHeight: COLLAPSED_BODY_HEIGHT }}
      >
        <div ref={contentRef}>
          {markdown ? (
            <PullRequestMarkdown text={body} cwd={cwd} />
          ) : (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{body}</p>
          )}
        </div>
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function PullRequestTimelineTab({ detail }: { detail: PullRequestDetail }) {
  const events = buildPullRequestTimeline(detail);
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };
  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {events.map((event) => (
          <article
            key={event.id}
            className="relative pb-5 text-sm [contain-intrinsic-block-size:56px] [content-visibility:auto]"
          >
            <span
              aria-hidden
              className="absolute -left-[1.55rem] top-1 size-2 rounded-full border border-border bg-background"
            />
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{event.title}</div>
                <div className="text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(event.at)}
                </div>
              </div>
              {/* Commits and the opened/merged events have no page of their own on the host,
                  so they get no control rather than one that would go nowhere. */}
              {event.url ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Open in browser"
                  onClick={() => event.url && openOnHost(event.url)}
                >
                  <ExternalLinkIcon className="size-3" />
                </Button>
              ) : null}
            </div>
            {event.body ? (
              <TimelineBody
                body={event.body}
                markdown={event.markdown}
                cwd={detail.workspaceRoot}
              />
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
