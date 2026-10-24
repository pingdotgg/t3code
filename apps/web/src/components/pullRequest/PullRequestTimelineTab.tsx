import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestActor,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  isPullRequestVerdictStale,
  newestPullRequestCommitAt,
  pullRequestReviewOutcome,
  type PullRequestReviewOutcome,
  type PullRequestTimelineEvent,
  type PullRequestTimelineThread,
} from "./pullRequestDetail.logic";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeLabel,
  pullRequestReviewOutcomeStaleLabel,
  pullRequestReviewOutcomeToneClassName,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

interface ReactionSurface {
  readonly canReact: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly reference: PullRequestRef;
  readonly onRefresh: () => void;
}

function TimelineBody({
  body,
  markdown,
  cwd,
  environmentId,
  threadRef,
}: {
  body: string;
  markdown: boolean;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
}) {
  return (
    <div className="mt-3">
      {markdown ? (
        <PullRequestMarkdown
          text={body}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef}
        />
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
          "size-7 bg-muted text-3xs transition-opacity",
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
    <span className="text-3xs font-medium text-muted-foreground">{friendlyReviewState(state)}</span>
  );
}

function OpenOnHostButton({ url, onOpen }: { url: string | null; onOpen: (url: string) => void }) {
  return url === null ? null : (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      className="-mr-1 shrink-0"
      aria-label="Open activity on host"
      onClick={() => onOpen(url)}
    >
      <ExternalLinkIcon className="size-3" />
    </Button>
  );
}

function ConversationCard({
  event,
  editable,
  cwd,
  onOpen,
  reactions,
  showPath = true,
}: {
  event: PullRequestTimelineEvent;
  editable: PullRequestComment | null;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
  showPath?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });

  const save = async (body: string) => {
    // A review's own summary is not a kind any host rewrites, which is why `editable` is never
    // one; the check is here because the comment's own type still allows it.
    if (editable === null || saving || editable.kind === "review") return;
    setSaving(true);
    const result = await updateComment({
      environmentId: reactions.environmentId,
      input: { ...reactions.reference, commentId: editable.id, kind: editable.kind, body },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the comment" });
      return;
    }
    setEditing(false);
    reactions.onRefresh();
  };

  return (
    <article className="group py-2">
      <div className="px-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
              <ActorName actor={event.actor} />
              <span className="text-muted-foreground">{event.title}</span>
              {event.reviewState ? <ReviewStateBadge state={event.reviewState} /> : null}
            </div>
            <PullRequestMetaLine className="mt-1 flex-wrap text-2xs text-muted-foreground">
              <span>
                <RelativeTime timestamp={event.at} />
              </span>
              {showPath && event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
          </div>
          {editable !== null && !editing ? (
            <PullRequestEditButton aria-label="Edit comment" onClick={() => setEditing(true)} />
          ) : null}
          {reactions.canReact || event.reactions.length > 0 ? (
            <PullRequestReactionBar
              className="ml-auto justify-end"
              reactions={event.reactions}
              canReact={reactions.canReact}
              subjectId={event.id}
              environmentId={reactions.environmentId}
              reference={reactions.reference}
              onRefresh={reactions.onRefresh}
            />
          ) : null}
          <OpenOnHostButton url={event.url} onOpen={onOpen} />
        </div>
      </div>
      {editing && editable !== null ? (
        <div className="px-2 pb-2 pt-3">
          <PullRequestMarkdownEditor
            value={editable.body}
            cwd={cwd}
            environmentId={reactions.environmentId}
            threadRef={reactions.threadRef}
            label="Edit comment"
            saving={saving}
            onSave={(body) => void save(body)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : event.body ? (
        <div className="px-2 pb-2">
          <TimelineBody
            body={event.body}
            markdown={event.markdown}
            cwd={cwd}
            environmentId={reactions.environmentId}
            threadRef={reactions.threadRef}
          />
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
  editable,
  cwd,
  onOpen,
  reactions,
}: {
  events: ReadonlyArray<PullRequestTimelineEvent>;
  editable: ReadonlyMap<string, PullRequestComment>;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
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
              <span className="block truncate text-3xs text-muted-foreground">
                {actors.length.toLocaleString()} {actors.length === 1 ? "author" : "authors"} ·{" "}
                <RelativeTime timestamp={first.at} />
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
                  <ConversationCard
                    // Named with the pull request too: a remark's id is the host's own, and two
                    // pull requests can hand out the same one — which would leave one card's open
                    // editor standing over the other's remark.
                    key={`${reactions.reference.projectId}#${reactions.reference.number}:${event.id}`}
                    event={event}
                    editable={editable.get(event.id) ?? null}
                    cwd={cwd}
                    onOpen={onOpen}
                    reactions={reactions}
                  />
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </div>
  );
}

function ReviewThreadEvent({
  event,
  thread,
  editable,
  cwd,
  onOpen,
  reactions,
}: {
  event: PullRequestTimelineEvent;
  thread: PullRequestTimelineThread;
  editable: ReadonlyMap<string, PullRequestComment>;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
}) {
  const dismissed = pullRequestReviewOutcome(event.reviewState) === "dismissed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !dismissed);
  const replyCount = thread.replies.length + thread.moreReplies;

  return (
    <div className="group relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        className="top-4"
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!expanded}
      />
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-2 py-2 text-left text-2xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <FileCode2Icon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate font-mono">
          {thread.line === null ? thread.path : `${thread.path}:${thread.line}`}
        </span>
        {thread.isResolved ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-success-foreground">
            <CircleCheckIcon aria-hidden className="size-3" />
            Resolved
          </span>
        ) : null}
        {dismissed ? <span className="shrink-0 font-medium">Review dismissed</span> : null}
        {thread.isOutdated ? <span className="shrink-0 font-medium">Outdated</span> : null}
        {expanded ? null : (
          <span className="shrink-0">
            · {event.actor?.login ?? "ghost"}
            {replyCount > 0 ? (
              <>
                {" "}
                · {replyCount.toLocaleString()} {replyCount === 1 ? "reply" : "replies"}
              </>
            ) : null}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <>
          <ConversationCard
            event={event}
            editable={editable.get(event.id) ?? null}
            cwd={cwd}
            onOpen={onOpen}
            reactions={reactions}
            showPath={false}
          />
          {thread.replies.length > 0 ? (
            <div className="ml-2 space-y-1 border-l border-border/60 pl-3">
              {thread.replies.map((reply) => (
                <ConversationCard
                  key={reply.id}
                  event={reply}
                  editable={editable.get(reply.id) ?? null}
                  cwd={cwd}
                  onOpen={onOpen}
                  reactions={reactions}
                  showPath={false}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {thread.hasMoreReplies ? (
        <div className="px-2">
          <PullRequestMoreReplies {...thread} />
        </div>
      ) : null}
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
      className="group relative mb-5 block w-full cursor-pointer rounded-sm pl-12 text-left outline-none [contain-intrinsic-block-size:48px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs text-muted-foreground">
            <code className="font-mono">{event.id.slice(0, 7)}</code>
            <span>
              <RelativeTime timestamp={event.at} />
            </span>
          </div>
        </div>
        {event.additions !== null && event.deletions !== null ? (
          <PullRequestDiffStat
            additions={event.additions}
            deletions={event.deletions}
            className="ml-auto shrink-0 font-mono text-3xs"
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
          icon: <PullRequestGlyph.pullRequest className="size-3.5" />,
          label: "Pull request opened",
        }
      : event.kind === "merged"
        ? {
            icon: <PullRequestGlyph.merged className="size-3.5" />,
            label: "Pull request merged",
          }
        : {
            icon: <PullRequestGlyph.closed className="size-3.5" />,
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
        <div className="mt-0.5 text-2xs text-muted-foreground">
          <RelativeTime timestamp={event.at} />
        </div>
      </div>
    </div>
  );
}

function ReviewVerdictEvent({
  event,
  outcome,
  stale,
  cwd,
  onOpen,
  reactions,
}: {
  event: PullRequestTimelineEvent;
  outcome: PullRequestReviewOutcome;
  stale: boolean;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
}) {
  return (
    <div className="group relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        className="top-6"
        fallback={<PullRequestReviewOutcomeIcon outcome={outcome} />}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={event.actor} />
            <Tooltip disabled={!stale}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "font-medium lowercase",
                      stale
                        ? "text-muted-foreground opacity-70"
                        : pullRequestReviewOutcomeToneClassName(outcome),
                    )}
                  />
                }
              >
                {pullRequestReviewOutcomeLabel(outcome)}
                {stale ? <span className="sr-only">, before the latest commits</span> : null}
              </TooltipTrigger>
              <TooltipPopup>{pullRequestReviewOutcomeStaleLabel(outcome)}</TooltipPopup>
            </Tooltip>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PullRequestMetaLine className="flex-wrap text-2xs text-muted-foreground">
              <span>
                <RelativeTime timestamp={event.at} />
              </span>
              {event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
          </div>
        </div>
        {reactions.canReact || event.reactions.length > 0 ? (
          <PullRequestReactionBar
            className="ml-auto justify-end"
            reactions={event.reactions}
            canReact={reactions.canReact}
            subjectId={event.id}
            environmentId={reactions.environmentId}
            reference={reactions.reference}
            onRefresh={reactions.onRefresh}
          />
        ) : null}
        <OpenOnHostButton url={event.url} onOpen={onOpen} />
      </div>
      {event.body ? (
        <TimelineBody
          body={event.body}
          markdown={event.markdown}
          cwd={cwd}
          environmentId={reactions.environmentId}
          threadRef={reactions.threadRef}
        />
      ) : null}
    </div>
  );
}

export function PullRequestTimelineTab({
  scrollerRef,
  detail,
  environmentId,
  threadRef = null,
  reference,
  order,
  onOpenCommit,
  onRefresh,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  reference: PullRequestRef;
  order: "newest" | "oldest";
  onOpenCommit: (oid: string) => void;
  onRefresh: () => void;
}) {
  const events = buildPullRequestTimeline(detail);
  const newestCommitAt = newestPullRequestCommitAt(detail.commits);
  const reactions: ReactionSurface = {
    canReact: detail.capabilities.reactions === true,
    environmentId,
    threadRef,
    reference,
    onRefresh,
  };
  const editable = new Map(
    events
      .flatMap((event) => [event, ...(event.thread?.replies ?? [])])
      .flatMap((event) => (event.comment ? [event.comment] : []))
      .filter((comment) => canEditPullRequestComment(detail, comment))
      .map((comment) => [comment.id, comment] as const),
  );
  const orderedEvents = order === "newest" ? events : events.toReversed();
  const rows = groupPullRequestTimelineConversations(orderedEvents);
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  return (
    <div ref={scrollerRef} className="scrollbar-gutter-both h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-3xl">
        <div className="relative">
          <span aria-hidden className="absolute bottom-5 left-[15px] top-1 w-px bg-border/45" />
          {rows.map((row) => {
            if (row.kind === "comments") {
              return (
                <ConversationGroup
                  key={`comments:${row.events[0]?.id ?? "empty"}`}
                  events={row.events}
                  editable={editable}
                  cwd={detail.workspaceRoot}
                  onOpen={openOnHost}
                  reactions={reactions}
                />
              );
            }
            const event = row.event;
            if (event.thread !== undefined) {
              return (
                <ReviewThreadEvent
                  key={`${reactions.reference.projectId}#${reactions.reference.number}:thread:${event.id}:${event.thread.isResolved}:${pullRequestReviewOutcome(event.reviewState) === "dismissed"}`}
                  event={event}
                  thread={event.thread}
                  editable={editable}
                  cwd={detail.workspaceRoot}
                  onOpen={openOnHost}
                  reactions={reactions}
                />
              );
            }
            if (event.kind === "commit") {
              return <CommitEvent key={event.id} event={event} onOpen={onOpenCommit} />;
            }
            const outcome = pullRequestReviewOutcome(event.reviewState);
            if (outcome !== null) {
              return (
                <ReviewVerdictEvent
                  key={event.id}
                  event={event}
                  outcome={outcome}
                  stale={isPullRequestVerdictStale(event.at, newestCommitAt)}
                  cwd={detail.workspaceRoot}
                  onOpen={openOnHost}
                  reactions={reactions}
                />
              );
            }
            return <LifecycleEvent key={event.id} event={event} />;
          })}
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <PullRequestGlyph.pullRequest className="mb-2 size-5" />
            <p className="text-xs">No activity yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
