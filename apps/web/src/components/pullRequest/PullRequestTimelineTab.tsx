import type { PullRequestActor, PullRequestDetailView } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  type PullRequestTimelineEvent,
} from "./pullRequestDetail.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
} from "./pullRequestPresentation";

function TimelineBody({ body, markdown, cwd }: { body: string; markdown: boolean; cwd: string }) {
  return (
    <div className="mt-3">
      {markdown ? (
        <PullRequestMarkdown text={body} cwd={cwd} />
      ) : (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{body}</p>
      )}
    </div>
  );
}

function ActorName({ actor }: { actor: PullRequestActor | null }) {
  return <span className="font-semibold text-foreground">{actor?.login ?? "ghost"}</span>;
}

function TimelineMarker({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 items-center justify-center bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

function IconMarker({ icon, className }: { icon: ReactNode; className?: string | undefined }) {
  return (
    <TimelineMarker className={className}>
      <span className="flex size-7 items-center justify-center bg-background text-muted-foreground">
        {icon}
      </span>
    </TimelineMarker>
  );
}

function ActorTimelineMarker({
  actors,
  className,
  fallback,
  muted = false,
}: {
  actors: ReadonlyArray<PullRequestActor>;
  className?: string | undefined;
  fallback: ReactNode;
  muted?: boolean;
}) {
  const actor = actors[0];
  return actor === undefined ? (
    <IconMarker className={className} icon={fallback} />
  ) : (
    <TimelineMarker className={className}>
      <PullRequestActorAvatar
        actor={actor}
        className={cn(
          "size-7 bg-muted text-[9px] transition-opacity",
          muted && "opacity-45 grayscale",
        )}
      />
    </TimelineMarker>
  );
}

function friendlyReviewState(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  return words.replace(/^\w/u, (letter) => letter.toUpperCase());
}

function ReviewStateBadge({ state }: { state: string }) {
  return (
    <span className="text-[10px] font-medium text-muted-foreground">
      {friendlyReviewState(state)}
    </span>
  );
}

function OpenOnHostButton({ url, onOpen }: { url: string | null; onOpen: (url: string) => void }) {
  return url === null ? null : (
    <Button
      size="icon-xs"
      variant="ghost"
      className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
      aria-label="Open activity on host"
      onClick={() => onOpen(url)}
    >
      <ExternalLinkIcon className="size-3" />
    </Button>
  );
}

function ConversationCard({
  event,
  cwd,
  onOpen,
}: {
  event: PullRequestTimelineEvent;
  cwd: string;
  onOpen: (url: string) => void;
}) {
  return (
    <article className="py-2">
      <div className="px-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
              <ActorName actor={event.actor} />
              <span className="text-muted-foreground">{event.title}</span>
              {event.reviewState ? <ReviewStateBadge state={event.reviewState} /> : null}
            </div>
            <PullRequestMetaLine className="mt-1 flex-wrap text-[11px] text-muted-foreground">
              <span>{formatRelativeTimeLabel(event.at)}</span>
              {event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
          </div>
          <OpenOnHostButton url={event.url} onOpen={onOpen} />
        </div>
      </div>
      {event.body ? (
        <div className="px-2 pb-2">
          <TimelineBody body={event.body} markdown={event.markdown} cwd={cwd} />
        </div>
      ) : null}
    </article>
  );
}

function uniqueConversationActors(events: ReadonlyArray<PullRequestTimelineEvent>) {
  const actors = new Map<string, PullRequestActor>();
  for (const event of events) {
    const actor = event.actor;
    if (actor !== null && !actors.has(actor.login)) actors.set(actor.login, actor);
  }
  return [...actors.values()];
}

function ConversationGroup({
  events,
  cwd,
  onOpen,
}: {
  events: ReadonlyArray<PullRequestTimelineEvent>;
  cwd: string;
  onOpen: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const actors = uniqueConversationActors(events);
  const first = events[0];
  if (first === undefined) return null;

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={actors}
        className="top-6"
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!open}
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div>
          <CollapsibleTrigger
            className={cn(
              "flex w-full min-w-0 items-center gap-3 py-2 text-left transition-opacity hover:opacity-100",
              open ? "text-foreground opacity-100" : "text-muted-foreground opacity-55",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">
                {events.length.toLocaleString()} {events.length === 1 ? "comment" : "comments"}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {actors.length.toLocaleString()} {actors.length === 1 ? "author" : "authors"} ·{" "}
                {formatRelativeTimeLabel(first.at)}
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {open ? (
              <div className="mt-1 space-y-1">
                {events.map((event) => (
                  <ConversationCard key={event.id} event={event} cwd={cwd} onOpen={onOpen} />
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </div>
  );
}

function CommitEvent({
  event,
  onOpen,
}: {
  event: PullRequestTimelineEvent;
  onOpen: (oid: string) => void;
}) {
  return (
    <button
      type="button"
      className="group relative mb-5 block w-full rounded-sm pl-12 text-left outline-none [contain-intrinsic-block-size:48px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`View commit ${event.id}`}
      onClick={() => onOpen(event.id)}
    >
      <ActorTimelineMarker
        actors={event.commitAuthors}
        fallback={<GitCommitHorizontalIcon className="size-3.5" />}
      />
      <div className="flex min-w-0 items-center gap-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
            {event.body ?? "Untitled commit"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <code className="font-mono">{event.id.slice(0, 7)}</code>
            <span>{formatRelativeTimeLabel(event.at)}</span>
          </div>
        </div>
        {event.additions !== null && event.deletions !== null ? (
          <PullRequestDiffStat
            additions={event.additions}
            deletions={event.deletions}
            className="ml-auto shrink-0 font-mono text-[10px]"
          />
        ) : null}
      </div>
    </button>
  );
}

function LifecycleEvent({ event }: { event: PullRequestTimelineEvent }) {
  const presentation =
    event.kind === "opened"
      ? {
          icon: <GitPullRequestIcon className="size-3.5" />,
          label: "Pull request opened",
        }
      : event.kind === "merged"
        ? {
            icon: <GitMergeIcon className="size-3.5" />,
            label: "Pull request merged",
          }
        : {
            icon: <GitPullRequestClosedIcon className="size-3.5" />,
            label: "Pull request closed",
          };

  return (
    <div className="relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <IconMarker icon={presentation.icon} />
      <div className="py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.actor ? <ActorName actor={event.actor} /> : null}
          <span className="font-semibold text-foreground">{presentation.label}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {formatRelativeTimeLabel(event.at)}
        </div>
      </div>
    </div>
  );
}

export function PullRequestTimelineTab({
  detail,
  order,
  onOpenCommit,
}: {
  detail: PullRequestDetailView;
  order: "newest" | "oldest";
  onOpenCommit: (oid: string) => void;
}) {
  const events = buildPullRequestTimeline(detail);
  const orderedEvents = order === "newest" ? events : events.toReversed();
  const rows = groupPullRequestTimelineConversations(orderedEvents);
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          <span aria-hidden className="absolute bottom-5 left-[15px] top-1 w-px bg-border/45" />
          {rows.map((row) => {
            if (row.kind === "comments") {
              return (
                <ConversationGroup
                  key={`comments:${row.events[0]?.id ?? "empty"}`}
                  events={row.events}
                  cwd={detail.workspaceRoot}
                  onOpen={openOnHost}
                />
              );
            }
            const event = row.event;
            if (event.kind === "commit") {
              return <CommitEvent key={event.id} event={event} onOpen={onOpenCommit} />;
            }
            return <LifecycleEvent key={event.id} event={event} />;
          })}
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <GitPullRequestIcon className="mb-2 size-5" />
            <p className="text-xs">No activity yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
