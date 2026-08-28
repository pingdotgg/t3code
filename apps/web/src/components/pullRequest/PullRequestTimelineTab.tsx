import type {
  EnvironmentId,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
} from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  PencilIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { ActorName, ActorTimelineMarker, IconMarker } from "../sourceControl/TimelineRail";
import { ConversationGroup } from "../sourceControl/ConversationGroup";
import { TimelineComment } from "../sourceControl/TimelineComment";
import { Button } from "../ui/button";
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
} from "./pullRequestDetail.logic";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
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

/** What every comment on the timeline needs to react; only the subject differs between them. */
interface ReactionSurface {
  readonly canReact: boolean;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onRefresh: () => void;
}

function TimelineBody({
  body,
  markdown,
  cwd,
  environmentId,
}: {
  body: string;
  markdown: boolean;
  cwd: string;
  environmentId: EnvironmentId;
}) {
  return markdown ? (
    <PullRequestMarkdown text={body} cwd={cwd} environmentId={environmentId} />
  ) : (
    <p className="whitespace-pre-wrap text-xs text-muted-foreground">{body}</p>
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
    <TimelineComment
      actor={event.actor}
      title={event.title}
      at={event.at}
      url={event.url}
      onOpen={onOpen}
      badge={event.reviewState ? <ReviewStateBadge state={event.reviewState} /> : null}
      meta={
        event.path ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            <FileCode2Icon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{event.path}</span>
          </span>
        ) : null
      }
      actions={
        editable !== null && !editing ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="-mt-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Edit comment"
            onClick={() => setEditing(true)}
          >
            <PencilIcon className="size-3" />
          </Button>
        ) : null
      }
      body={
        editing && editable !== null ? (
          <PullRequestMarkdownEditor
            value={editable.body}
            cwd={cwd}
            environmentId={reactions.environmentId}
            label="Edit comment"
            saving={saving}
            onSave={(body) => void save(body)}
            onCancel={() => setEditing(false)}
          />
        ) : event.body || reactions.canReact || event.reactions.length > 0 ? (
          <>
            {event.body ? (
              <TimelineBody
                body={event.body}
                markdown={event.markdown}
                cwd={cwd}
                environmentId={reactions.environmentId}
              />
            ) : null}
            {reactions.canReact || event.reactions.length > 0 ? (
              <div className={event.body ? "mt-2" : undefined}>
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
          </>
        ) : null
      }
    />
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

/**
 * A verdict, as its own row rather than a line inside a collapsed conversation. It wears the
 * reviewer's face on the rail and the verdict's own icon beside their name, so "approved" reads
 * at a glance from the same place a merge or a commit does.
 */
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
  /** Commits landed after this verdict, so it speaks for code the branch no longer has. */
  stale: boolean;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
}) {
  return (
    <div className="group relative mb-5 pl-12 [contain-intrinsic-block-size:48px] [content-visibility:auto]">
      {/* Pinned rather than centred: this row grows with a body and a reaction bar, and a
          centred avatar drifts down beside them instead of sitting by the name. */}
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        className="top-6"
        fallback={<PullRequestReviewOutcomeIcon outcome={outcome} />}
      />
      <div className="flex min-w-0 items-start gap-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <ActorName actor={event.actor} />
            {/* The word alone, in the verdict's own colour — green for an approval, red for a
                request for changes. A verdict overtaken by later commits keeps its word and
                loses that colour: it still happened, and it no longer speaks for what is on the
                branch. Lowercased in the styling rather than the string, so what a screen reader
                announces stays the label every other surface uses. */}
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
          {/* The reaction bar rides this line rather than taking one of its own. Its add button
              is invisible until hovered but still occupies `h-6`, and under a verdict — usually a
              single line with no body — a row of that reserved on its own reads as a hole. */}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PullRequestMetaLine className="flex-wrap text-[11px] text-muted-foreground">
              <span>{formatRelativeTimeLabel(event.at)}</span>
              {event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
            {reactions.canReact || event.reactions.length > 0 ? (
              <PullRequestReactionBar
                reactions={event.reactions}
                canReact={reactions.canReact}
                subjectId={event.id}
                environmentId={reactions.environmentId}
                reference={reactions.reference}
                onRefresh={reactions.onRefresh}
              />
            ) : null}
          </div>
          {/* An approval usually carries no words. When it does they are the review, so they stay
              visible rather than being folded away with the ordinary conversation. */}
          {event.body ? (
            <div className="mt-3">
              <TimelineBody
                body={event.body}
                markdown={event.markdown}
                cwd={cwd}
                environmentId={reactions.environmentId}
              />
            </div>
          ) : null}
        </div>
        <OpenOnHostButton url={event.url} onOpen={onOpen} />
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
  const newestCommitAt = newestPullRequestCommitAt(detail.commits);
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
                  entries={row.events}
                  keyPrefix={`${reference.projectId}#${reference.number}:`}
                  onOpen={openOnHost}
                  renderComment={(event) => (
                    <ConversationCard
                      event={event}
                      editable={editable.get(event.id) ?? null}
                      cwd={detail.workspaceRoot}
                      onOpen={openOnHost}
                      reactions={reactions}
                    />
                  )}
                />
              );
            }
            const event = row.event;
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
            <GitPullRequestIcon className="mb-2 size-5" />
            <p className="text-xs">No activity yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
