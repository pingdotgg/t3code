import type {
  EnvironmentId,
  PullRequestActor,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  PencilIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  type PullRequestTimelineEvent,
} from "./pullRequestDetail.logic";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
} from "./pullRequestPresentation";

/** What every comment on the timeline needs to react; only the subject differs between them. */
interface ReactionSurface {
  readonly canReact: boolean;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onRefresh: () => void;
}

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
  editable,
  cwd,
  onOpen,
  reactions,
}: {
  event: PullRequestTimelineEvent;
  /** The remark behind this entry, only where this reader may rewrite it. */
  editable: PullRequestComment | null;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
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
          {editable !== null && !editing ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-mt-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Edit comment"
              onClick={() => setEditing(true)}
            >
              <PencilIcon className="size-3" />
            </Button>
          ) : null}
          <OpenOnHostButton url={event.url} onOpen={onOpen} />
        </div>
      </div>
      {editing && editable !== null ? (
        <div className="px-2 pb-2 pt-3">
          <PullRequestMarkdownEditor
            value={editable.body}
            cwd={cwd}
            label="Edit comment"
            saving={saving}
            onSave={(body) => void save(body)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : event.body ? (
        <div className="px-2 pb-2">
          <TimelineBody body={event.body} markdown={event.markdown} cwd={cwd} />
        </div>
      ) : null}
      {reactions.canReact || event.reactions.length > 0 ? (
        <div className="px-2 pb-2">
          <PullRequestReactionBar
            reactions={event.reactions}
            canReact={reactions.canReact}
            subjectId={event.id}
            environmentId={reactions.environmentId}
            reference={reactions.reference}
            onRefresh={reactions.onRefresh}
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
  environmentId,
  reference,
  order,
  onOpenCommit,
  onRefresh,
}: {
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  order: "newest" | "oldest";
  onOpenCommit: (oid: string) => void;
  onRefresh: () => void;
}) {
  const events = buildPullRequestTimeline(detail);
  const reactions: ReactionSurface = {
    canReact: detail.capabilities.reactions === true,
    environmentId,
    reference,
    onRefresh,
  };
  // A timeline entry keeps only what it draws, so the remarks this reader may rewrite are looked
  // up here by the id the entry carries.
  const editable = new Map(
    detail.comments
      .filter((comment) => canEditPullRequestComment(detail, comment))
      .map((comment) => [comment.id, comment] as const),
  );
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
                  editable={editable}
                  cwd={detail.workspaceRoot}
                  onOpen={openOnHost}
                  reactions={reactions}
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
