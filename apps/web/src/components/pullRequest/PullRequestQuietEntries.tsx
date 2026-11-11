import type { PullRequestActor } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatFullTimestamp } from "~/timestampFormat";

import { InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PullRequestReviewOutcome } from "./pullRequestDetail.logic";
import {
  PullRequestActorLabel,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeVerb,
} from "./pullRequestPresentation";

export function PullRequestCommentTime({
  createdAt,
  url,
}: {
  createdAt: string;
  url: string | null;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          url ? (
            <InlineButton
              tone="muted"
              render={<a href={url} target="_blank" rel="noopener noreferrer" />}
            />
          ) : (
            <span className="text-muted-foreground" />
          )
        }
      >
        <time dateTime={createdAt}>
          <RelativeTime timestamp={createdAt} />
        </time>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex flex-col gap-0.5">
          <span>{formatFullTimestamp(createdAt, timestampFormat)}</span>
          {url ? <span>Open comment on host</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A review as one event line: who, what they decided, when. Any text the review carries stays
 * a quiet peek on the line and opens in place.
 */
export function PullRequestReviewEntry({
  actor,
  profileUrl,
  createdAt,
  url,
  outcome,
  stateLabel,
  preview,
  action,
  children,
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
  actor: PullRequestActor | null;
  profileUrl: string | null;
  createdAt: string;
  url: string | null;
  outcome: PullRequestReviewOutcome | null;
  /** The host's own word for a review that is neither an approval nor a change request. */
  stateLabel: string;
  preview: string | null;
  action?: ReactNode;
  /** What opens under the line: the review's text, its reactions. Null leaves nothing to open. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = children !== null && children !== false;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-h-7 min-w-0 items-center gap-2 px-3 text-meta text-muted-foreground">
        <PullRequestActorLabel
          actor={actor}
          profileUrl={profileUrl}
          className="max-w-[55%] shrink-0"
        />
        <span className="inline-flex min-w-0 items-center gap-1">
          {outcome ? (
            <PullRequestReviewOutcomeIcon outcome={outcome} />
          ) : (
            <MessageSquareIcon aria-hidden className="size-3.5 text-dim-foreground" />
          )}
          <span className="truncate">
            {outcome ? pullRequestReviewOutcomeVerb(outcome) : stateLabel}
          </span>
        </span>
        {expandable ? (
          <CollapsibleTrigger
            variant="muted"
            aria-label={open ? "Hide review text" : "Show review text"}
            className="min-w-0 flex-1 shrink gap-1 text-left"
          >
            <span className="min-w-0 flex-1 truncate">{open ? null : preview}</span>
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
            />
          </CollapsibleTrigger>
        ) : (
          <span className="flex-1" />
        )}
        {action}
        <span className="shrink-0">
          <PullRequestCommentTime createdAt={createdAt} url={url} />
        </span>
      </div>
      {expandable ? (
        <CollapsiblePanel>
          {open ? <div className="pt-1 pr-3 pb-1 pl-8.5">{children}</div> : null}
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
}

/** A finished thread folded to one quiet line; it opens into the full conversation. */
export function PullRequestResolvedThreadRow({
  path,
  line,
  outdated,
  dismissed,
  commentCount,
  action,
  children,
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
  path: string | null;
  line: number | null | undefined;
  outdated: boolean;
  /** The thread is still open on the host, but the review that started it was dismissed. */
  dismissed: boolean;
  commentCount: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const label = path === null ? "Overview" : `${path}${line ? `:${line}` : ""}`;
  const comments = `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center pr-3">
        <CollapsibleTrigger
          variant="muted"
          aria-label={`${dismissed ? "Dismissed" : "Resolved"} thread on ${label}, ${comments}`}
          className="min-w-0 flex-1 shrink gap-2 px-3 text-left"
        >
          {dismissed ? (
            <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />
          ) : (
            <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
          {outdated ? <span className="shrink-0">Outdated</span> : null}
          <span className="shrink-0">{comments}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsiblePanel>{open ? <div className="pt-2">{children}</div> : null}</CollapsiblePanel>
    </Collapsible>
  );
}
