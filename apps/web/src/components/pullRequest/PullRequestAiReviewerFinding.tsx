import {
  aiReviewerOneLine,
  parseAiReviewerFeedback,
  type AiReviewerFeedback,
} from "@t3tools/client-runtime/ai-reviewer-feedback";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestComment,
  PullRequestDetailView,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { ChevronRightIcon, HammerIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorLabel } from "./pullRequestPresentation";

export function pullRequestAiReviewerFeedback(
  comment: Pick<PullRequestComment, "body">,
): AiReviewerFeedback | null {
  return parseAiReviewerFeedback(comment.body);
}

/** Collapsed by default to one line; expands for the finding body and replies. */
export function PullRequestAiReviewerFinding({
  comment,
  detail,
  thread,
  fixLabel,
  fixPending,
  onFix,
  onAddToChat,
  reactionBar,
  children,
}: {
  comment: PullRequestComment;
  detail: PullRequestDetailView;
  thread: PullRequestReviewThread | undefined;
  fixLabel?: string | undefined;
  fixPending?: boolean | undefined;
  onFix?: (() => void) | undefined;
  onAddToChat?: (() => void) | undefined;
  reactionBar?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const feedback = parseAiReviewerFeedback(comment.body);
  if (feedback === null) return null;
  const oneLine = aiReviewerOneLine(feedback);
  const path = thread?.path ?? comment.path;
  const pathLabel =
    path === null || path === undefined ? null : `${path}${thread?.line ? `:${thread.line}` : ""}`;
  const profileUrl = comment.author
    ? sourceControlClients.get(detail.provider).authorProfileUrl(comment.author.login, detail.url)
    : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <article className="group rounded-lg border border-border/60 bg-background">
        <div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-xs hover:bg-muted/60">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "-me-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <PullRequestActorLabel
              actor={comment.author}
              profileUrl={profileUrl}
              className="max-w-[9rem] shrink-0"
            />
            {pathLabel ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="hidden max-w-[10rem] shrink-0 truncate font-mono text-muted-foreground sm:inline" />
                  }
                >
                  {pathLabel}
                </TooltipTrigger>
                <TooltipPopup>{pathLabel}</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{oneLine}</span>
            <time
              dateTime={comment.createdAt}
              className="hidden shrink-0 text-muted-foreground md:inline"
            >
              <RelativeTime timestamp={comment.createdAt} />
            </time>
          </CollapsibleTrigger>
          {onFix ? (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              disabled={fixPending === true}
              onClick={onFix}
            >
              <span className="inline-flex items-baseline gap-1">
                <HammerIcon className="size-3 self-center" />
                <span>{fixPending === true ? "Preparing..." : (fixLabel ?? "Easy fix")}</span>
              </span>
            </Button>
          ) : null}
          {onAddToChat ? (
            <Button size="xs" variant="ghost" className="shrink-0" onClick={onAddToChat}>
              Add to chat
            </Button>
          ) : null}
          {reactionBar}
        </div>
        {/* Keep children mounted so CollapsiblePanel can animate height open and closed. */}
        <CollapsiblePanel>
          <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
            {pathLabel ? (
              <div className="truncate font-mono text-xs text-muted-foreground sm:hidden">
                {pathLabel}
              </div>
            ) : null}
            {children}
          </div>
        </CollapsiblePanel>
      </article>
    </Collapsible>
  );
}
