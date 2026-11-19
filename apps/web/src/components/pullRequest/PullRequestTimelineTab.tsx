import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  resolvePullRequestReviewAnchor,
} from "@t3tools/shared/pullRequestAnchor";
import { holdLinkedNodeInView } from "./holdLinkedNodeInView";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
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
  HammerIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { m } from "~/i18n/messages";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

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
  filterPullRequestTimelineEvents,
  groupPullRequestTimelineConversations,
  pullRequestTimelineEventMatches,
  type PullRequestTimelineRow,
  isPullRequestVerdictStale,
  newestPullRequestCommitAt,
  pullRequestFindingKey,
  pullRequestReviewOutcome,
  visibleBody,
  type PullRequestChatSubject,
  type PullRequestFinding,
  type PullRequestReviewOutcome,
  type PullRequestTimelineEvent,
  type PullRequestTimelineThread,
} from "./pullRequestDetail.logic";
import { canEditPullRequestComment } from "@t3tools/client-runtime/pull-request-editing";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { canReactPullRequestComment } from "@t3tools/client-runtime/pull-request-reactions";
import { PullRequestResolveThreadButton } from "./PullRequestResolveThreadButton";
import {
  PullRequestActorAvatar,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeLabel,
  pullRequestReviewOutcomeStaleLabel,
  pullRequestReviewOutcomeToneClassName,
  resolvePullRequestState,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  type PullRequestCompletionScope,
  pullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

import { changeRequestTermKind, type ChangeRequestTermKind } from "./changeRequestTerm";

interface ReactionSurface {
  revealAnchor?: string | null;
  readonly canReact: (event: PullRequestTimelineEvent) => boolean;
  /** Absent where there is no composer beside the panel to add a remark to. */
  readonly onAddToChat?: ((comment: PullRequestComment) => void) | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly reference: PullRequestRef;
  readonly completionScope: PullRequestCompletionScope | null;
  readonly onRefresh: () => void;
  /** Absent where findings cannot be handed to an agent. */
  readonly fix?:
    | {
        readonly findingFor: (event: PullRequestTimelineEvent) => PullRequestFinding | null;
        readonly onFix: (finding: PullRequestFinding) => void;
        readonly pending: string | null;
        readonly label: string;
      }
    | undefined;
}

function FixFindingButton({
  event,
  reactions,
}: {
  event: PullRequestTimelineEvent;
  reactions: ReactionSurface;
}) {
  const gt = useGT();
  const fix = reactions.fix;
  const finding = fix?.findingFor(event) ?? null;
  if (!fix || finding === null) return null;
  const label = fix.pending === pullRequestFindingKey(finding) ? gt("Preparing...") : fix.label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="shrink-0"
            aria-label={label}
            disabled={fix.pending !== null}
            onClick={() => fix.onFix(finding)}
          />
        }
      >
        <HammerIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function TimelineBody({
  body,
  markdown,
  cwd,
  environmentId,
  threadRef,
  className = "mt-3",
}: {
  body: string;
  markdown: boolean;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  className?: string;
}) {
  return (
    <div className={className}>
      {markdown ? (
        <PullRequestMarkdown
          text={body}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
      )}
    </div>
  );
}

function ActorName({ actor }: { actor: PullRequestActor | null }) {
  return <span className="font-medium text-foreground">{actor?.login ?? "ghost"}</span>;
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
        "absolute left-0 top-2.5 z-10 flex size-6 items-center justify-center rounded-full bg-background",
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
      <span className="flex size-6 items-center justify-center bg-background text-muted-foreground">
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
          "size-6 bg-muted text-3xs transition-opacity",
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
  return <span className="text-muted-foreground">{friendlyReviewState(state)}</span>;
}

function AddToChatButton({
  comment,
  reactions,
}: {
  comment: PullRequestComment;
  reactions: ReactionSurface;
}) {
  const gt = useGT();
  const onAddToChat = reactions.onAddToChat;
  return onAddToChat === undefined ? null : (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="shrink-0"
            aria-label={gt("Add to chat")}
            onClick={() => onAddToChat(comment)}
          />
        }
      >
        <MessageSquarePlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>
        <T>Add to chat</T>
      </TooltipPopup>
    </Tooltip>
  );
}

function OpenOnHostButton({ url, onOpen }: { url: string | null; onOpen: (url: string) => void }) {
  const gt = useGT();
  return url === null ? null : (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      className="shrink-0"
      aria-label={gt("Open activity on host")}
      onClick={() => onOpen(url)}
    >
      <ExternalLinkIcon className="size-3.5" />
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
  reply = false,
  resolveButton = null,
}: {
  event: PullRequestTimelineEvent;
  editable: PullRequestComment | null;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
  showPath?: boolean;
  /** A reply goes with its conversation, from the card that heads it. */
  reply?: boolean;
  resolveButton?: ReactNode;
}) {
  const gt = useGT();
  const canReact = reactions.canReact(event);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });

  const save = async (body: string) => {
    if (editable === null || saving || editable.kind === "review") return;
    setSaving(true);
    const result = await updateComment({
      environmentId: reactions.environmentId,
      input: { ...reactions.reference, commentId: editable.id, kind: editable.kind, body },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: m(msg("Could not save the comment")) });
      return;
    }
    setEditing(false);
    reactions.onRefresh();
  };

  return (
    <article
      {...(reactions.revealAnchor != null &&
      pullRequestAnchorMatchesUrl(reactions.revealAnchor, event.url)
        ? {
            "data-pr-link-target": true,
            tabIndex: -1,
            // Inset: the collapsible panel clips an outer ring's left and right edges.
            className:
              "group overflow-hidden rounded-lg border border-(--shell-divider) ring-1 ring-inset ring-primary/40 outline-none",
          }
        : {
            className: "group overflow-hidden rounded-lg border border-(--shell-divider)",
          })}
    >
      <div
        className={cn(
          "bg-muted/25 py-1.5 ps-3 pe-1.5 [--control-radius:9999px] dark:bg-foreground/4",
          (event.body || editing) && "border-b border-(--shell-divider)",
        )}
      >
        <div className="flex min-h-7 min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-x-1.5 text-sm leading-5">
              {event.kind === "review" ? (
                <T>
                  <Var>
                    <ActorName actor={event.actor} />
                  </Var>{" "}
                  <span className="text-muted-foreground">reviewed</span>
                </T>
              ) : event.kind === "comment" ? (
                <T>
                  <Var>
                    <ActorName actor={event.actor} />
                  </Var>{" "}
                  <span className="text-muted-foreground">commented</span>
                </T>
              ) : (
                <>
                  <ActorName actor={event.actor} />
                  <span className="text-muted-foreground">{event.title}</span>
                </>
              )}
              {event.reviewState ? <ReviewStateBadge state={event.reviewState} /> : null}
              {/* The time sits on the name's line, so the header is one row. */}
              <span className="shrink-0 text-muted-foreground">
                · <RelativeTime timestamp={event.at} />
              </span>
            </div>
            <PullRequestMetaLine className="mt-0.5 flex-wrap text-sm text-muted-foreground empty:hidden">
              {showPath && event.path ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileCode2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{event.path}</span>
                </span>
              ) : null}
            </PullRequestMetaLine>
          </div>
          {editable !== null && !editing ? (
            <PullRequestEditButton
              aria-label={gt("Edit comment")}
              onClick={() => setEditing(true)}
            />
          ) : null}
          {reply ? null : <FixFindingButton event={event} reactions={reactions} />}
          {resolveButton}
          {event.body && event.comment && !reply ? (
            <AddToChatButton comment={event.comment} reactions={reactions} />
          ) : null}
          {canReact || event.reactions.length > 0 ? (
            <PullRequestReactionBar
              className="ml-auto justify-end"
              reactions={event.reactions}
              canReact={canReact}
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
        <div className="px-3 py-3">
          <PullRequestMarkdownEditor
            value={editable.body}
            cwd={cwd}
            environmentId={reactions.environmentId}
            completionScope={reactions.completionScope}
            threadRef={reactions.threadRef}
            label={gt("Edit comment")}
            saving={saving}
            onSave={(body) => void save(body)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : event.body ? (
        <div className="px-3 py-3">
          <TimelineBody
            className=""
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
  revealAnchor,
  events,
  editable,
  cwd,
  onOpen,
  reactions,
}: {
  revealAnchor?: string | null;
  events: ReadonlyArray<PullRequestTimelineEvent>;
  editable: ReadonlyMap<string, PullRequestComment>;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
}) {
  const [open, setOpen] = useState(
    () =>
      revealAnchor != null &&
      events.some((event) => pullRequestAnchorMatchesUrl(revealAnchor, event.url)),
  );
  const gt = useGT();
  const actors = uniqueConversationActors(events);
  const first = events[0];
  if (first === undefined) return null;

  return (
    <div className="relative py-3 pl-9 [contain-intrinsic-block-size:60px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={actors}
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!open}
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div>
          <CollapsibleTrigger
            className={cn(
              "group/trigger flex w-full min-w-0 cursor-pointer items-center gap-3 text-left",
              "text-foreground/90",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm leading-5 font-medium">
                {gt("{count, plural, one {{formatted} comment} other {{formatted} comments}}", {
                  count: events.length,
                  formatted: events.length.toLocaleString(),
                })}
              </span>
              <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                {gt("{count, plural, one {{formatted} author} other {{formatted} authors}}", {
                  count: actors.length,
                  formatted: actors.length.toLocaleString(),
                })}{" "}
                · <RelativeTime timestamp={first.at} />
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {open ? (
              <div className="mt-3 space-y-2">
                {events.map((event) => (
                  <ConversationCard
                    // Host comment ids can collide across pull requests.
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
  revealAnchor,
  event,
  thread,
  editable,
  cwd,
  onOpen,
  reactions,
  detail,
  body,
}: {
  revealAnchor?: string | null;
  event: PullRequestTimelineEvent;
  thread: PullRequestTimelineThread;
  /** Draws the open thread in place of its comment and reply cards. */
  body?: ReactNode;
  detail: PullRequestDetailView;
  editable: ReadonlyMap<string, PullRequestComment>;
  cwd: string;
  onOpen: (url: string) => void;
  reactions: ReactionSurface;
}) {
  const gt = useGT();
  const dismissed = pullRequestReviewOutcome(event.reviewState) === "dismissed";
  const [expanded, setExpanded] = useState(
    () =>
      (revealAnchor != null &&
        [event, ...thread.replies].some((item) =>
          pullRequestAnchorMatchesUrl(revealAnchor, item.url),
        )) ||
      (!thread.isResolved && !dismissed),
  );
  const replyCount = thread.replies.length + thread.moreReplies;

  return (
    <div className="group relative py-3 pl-9 [contain-intrinsic-block-size:60px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        fallback={<MessageSquareIcon className="size-3.5" />}
        muted={!expanded}
      />
      {/* The file as the row's title, its state and people as the meta line. */}
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-start gap-3 text-left",
          expanded ? "text-foreground/90" : "text-muted-foreground hover:text-foreground/90",
        )}
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5 font-medium">
            {thread.path === null ? (
              <span className="min-w-0 truncate">
                <T context="review thread without a file">Overview</T>
              </span>
            ) : (
              <>
                <FileCode2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">
                  {thread.line === null ? thread.path : `${thread.path}:${thread.line}`}
                </span>
              </>
            )}
          </span>
          <PullRequestMetaLine className="mt-1 flex-wrap text-sm text-muted-foreground">
            {thread.isResolved ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-success-foreground">
                <CircleCheckIcon aria-hidden className="size-3.5" />
                <T context="review thread state">Resolved</T>
              </span>
            ) : null}
            {dismissed ? (
              <span className="shrink-0">
                <T>Review dismissed</T>
              </span>
            ) : null}
            {thread.isOutdated ? (
              <span className="shrink-0">
                <T context="review thread state">Outdated</T>
              </span>
            ) : null}
            <span className="shrink-0">{event.actor?.login ?? "ghost"}</span>
            {replyCount > 0 ? (
              <span className="shrink-0">
                {gt("{count, plural, one {{formatted} reply} other {{formatted} replies}}", {
                  count: replyCount,
                  formatted: replyCount.toLocaleString(),
                })}
              </span>
            ) : null}
          </PullRequestMetaLine>
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {/* Folded, the body stays mounted, so an unsent reply survives. */}
      {body === undefined ? null : <div className={cn("mt-4", !expanded && "hidden")}>{body}</div>}
      {expanded && body === undefined ? (
        <div className="mt-4">
          <ConversationCard
            event={event}
            editable={editable.get(event.id) ?? null}
            cwd={cwd}
            onOpen={onOpen}
            reactions={reactions}
            showPath={false}
            resolveButton={
              <PullRequestResolveThreadButton
                environmentId={reactions.environmentId}
                reference={reactions.reference}
                detail={detail}
                thread={thread}
                onRefresh={reactions.onRefresh}
              />
            }
          />
          {thread.replies.length > 0 ? (
            // Each reply card hangs off a line that runs down from the comment it answers.
            <div className="mt-2 space-y-2 ps-6">
              {thread.replies.map((reply) => (
                <div
                  key={reply.id}
                  className="relative before:absolute before:top-5 before:-left-3 before:h-px before:w-3 before:bg-(--shell-divider) after:absolute after:-top-2 after:bottom-0 after:-left-3 after:w-px after:bg-(--shell-divider) last:after:bottom-auto last:after:h-7"
                >
                  <ConversationCard
                    event={reply}
                    editable={editable.get(reply.id) ?? null}
                    cwd={cwd}
                    onOpen={onOpen}
                    reactions={reactions}
                    showPath={false}
                    reply
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {thread.hasMoreReplies && body === undefined ? (
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
  const gt = useGT();
  return (
    <button
      type="button"
      className="group relative block w-full cursor-pointer rounded-sm py-3 pl-9 text-left outline-none [contain-intrinsic-block-size:48px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={gt("View commit {sha}", { sha: event.id })}
      onClick={() => onOpen(event.id)}
    >
      <ActorTimelineMarker
        actors={event.commitAuthors}
        fallback={<GitCommitHorizontalIcon className="size-3.5" />}
      />
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-5 font-medium text-foreground/90 transition-colors group-hover:text-foreground">
            {event.body ?? gt("Untitled commit")}
          </div>
          {/* The commit id in the interface font, then the time, with the dot used everywhere else. */}
          <PullRequestMetaLine className="mt-0.5 flex-wrap text-sm text-muted-foreground">
            <span>{event.id.slice(0, 7)}</span>
            <span>
              <RelativeTime timestamp={event.at} />
            </span>
          </PullRequestMetaLine>
        </div>
        {event.additions !== null && event.deletions !== null ? (
          <PullRequestDiffStat
            additions={event.additions}
            deletions={event.deletions}
            className="ml-auto shrink-0 font-mono text-sm leading-5"
          />
        ) : null}
      </div>
    </button>
  );
}

function LifecycleEvent({
  event,
  term,
}: {
  event: PullRequestTimelineEvent;
  term: ChangeRequestTermKind;
}) {
  const gt = useGT();
  // The event's icon sits in a circle in the colour of the state it leads to.
  const state = resolvePullRequestState({
    state: event.kind === "merged" ? "merged" : event.kind === "opened" ? "open" : "closed",
    isDraft: false,
  });
  const presentation =
    event.kind === "opened"
      ? {
          icon: <PullRequestGlyph.pullRequest className="size-3.5" />,
          label: gt(
            "opened this {term, select, mr {merge request} cr {change request} other {pull request}}",
            { term },
          ),
        }
      : event.kind === "merged"
        ? {
            icon: <PullRequestGlyph.merged className="size-3.5" />,
            label: gt(
              "merged this {term, select, mr {merge request} cr {change request} other {pull request}}",
              { term },
            ),
          }
        : {
            icon: <PullRequestGlyph.closed className="size-3.5" />,
            label: gt(
              "closed this {term, select, mr {merge request} cr {change request} other {pull request}}",
              { term },
            ),
          };

  return (
    <div className="relative py-3 pl-9 [contain-intrinsic-block-size:60px] [content-visibility:auto]">
      <TimelineMarker>
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-full bg-current/15 ring-1 ring-current/25 ring-inset",
            state.toneClassName,
          )}
        >
          {presentation.icon}
        </span>
      </TimelineMarker>
      <div className="text-sm leading-5">
        <div className="flex flex-wrap items-center gap-1.5">
          {event.actor ? <ActorName actor={event.actor} /> : null}
          <span className="text-muted-foreground">{presentation.label}</span>
        </div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          <RelativeTime timestamp={event.at} />
        </div>
      </div>
    </div>
  );
}

function staleReviewOutcomeLabel(
  outcome: PullRequestReviewOutcome,
  gt: ReturnType<typeof useGT>,
): string {
  switch (outcome) {
    case "approved":
      return gt("Approved, before the latest commits");
    case "changes-requested":
      return gt("Changes requested, before the latest commits");
    case "dismissed":
      return gt("Review dismissed, before the latest commits");
  }
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
  const gt = useGT();
  const resolve = useMessages();
  const canReact = reactions.canReact(event);
  return (
    <div className="group relative py-3 pl-9 [contain-intrinsic-block-size:60px] [content-visibility:auto]">
      <ActorTimelineMarker
        actors={event.actor ? [event.actor] : []}
        fallback={<PullRequestReviewOutcomeIcon outcome={outcome} />}
      />
      <div className="flex min-w-0 flex-wrap items-start gap-2 [--control-radius:9999px]">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm leading-5">
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
                {stale ? (
                  <>
                    <span aria-hidden>{pullRequestReviewOutcomeLabel(outcome, resolve)}</span>
                    <span className="sr-only">{staleReviewOutcomeLabel(outcome, gt)}</span>
                  </>
                ) : (
                  pullRequestReviewOutcomeLabel(outcome, resolve)
                )}
              </TooltipTrigger>
              <TooltipPopup>{pullRequestReviewOutcomeStaleLabel(outcome, resolve)}</TooltipPopup>
            </Tooltip>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PullRequestMetaLine className="flex-wrap text-sm text-muted-foreground">
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
        <FixFindingButton event={event} reactions={reactions} />
        {event.body && event.comment ? (
          <AddToChatButton comment={event.comment} reactions={reactions} />
        ) : null}
        {canReact || event.reactions.length > 0 ? (
          <PullRequestReactionBar
            className="ml-auto justify-end"
            reactions={event.reactions}
            canReact={canReact}
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

/** What "Fix in a thread" hands over for a timeline comment, or null when there is nothing to fix. */
function timelineFinding(
  detail: PullRequestDetailView,
  event: PullRequestTimelineEvent,
): PullRequestFinding | null {
  const comment = event.comment;
  if (comment === undefined || (comment.kind !== "review" && comment.kind !== "review-comment"))
    return null;
  if (pullRequestReviewOutcome(comment.reviewState) === "approved") return null;
  // An overview thread has no line to attach, so it goes as its opening remark.
  const thread =
    event.thread?.path == null
      ? undefined
      : detail.reviewThreads.find((candidate) => candidate.id === event.thread?.id);
  if (thread !== undefined) return { kind: "thread", thread };
  return visibleBody(comment.body) === null ? null : { kind: "comment", comment };
}

/**
 * Review threads as Timeline rows (path title and meta line) for threads the Code tab's diff
 * cannot place. `renderThread` draws each open thread, so it keeps the Code tab's reply, load-more,
 * fix and add-to-chat actions.
 */
export function PullRequestThreadList({
  detail,
  threadIds,
  environmentId,
  reference,
  onRefresh,
  renderThread,
}: {
  detail: PullRequestDetailView;
  threadIds: ReadonlySet<string>;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onRefresh: () => void;
  renderThread: (threadId: string) => ReactNode;
}) {
  const resolve = useMessages();
  const reactions: ReactionSurface = {
    revealAnchor: null,
    canReact: () => false,
    environmentId,
    threadRef: null,
    reference,
    completionScope: null,
    onRefresh,
  };
  const threads = buildPullRequestTimeline(detail, resolve).flatMap((event) =>
    event.thread !== undefined && threadIds.has(event.thread.id)
      ? [{ event, thread: event.thread }]
      : [],
  );
  return (
    <div>
      {threads.map(({ event, thread }) => (
        <ReviewThreadEvent
          key={event.id}
          event={event}
          thread={thread}
          detail={detail}
          editable={new Map()}
          cwd={detail.workspaceRoot}
          onOpen={() => {}}
          reactions={reactions}
          body={renderThread(thread.id)}
        />
      ))}
    </div>
  );
}

export const PULL_REQUEST_COMMENT_FILTER_STORAGE_KEY = "t3code:pull-request-comment-filter:v1";
export const PullRequestCommentFilterSchema = Schema.Struct({
  bots: Schema.Boolean,
  resolved: Schema.Boolean,
});
export type PullRequestCommentFilter = typeof PullRequestCommentFilterSchema.Type;
export const DEFAULT_PULL_REQUEST_COMMENT_FILTER: PullRequestCommentFilter = {
  bots: false,
  resolved: false,
};
const SHOW_ALL_COMMENTS: PullRequestCommentFilter = { bots: true, resolved: true };

export function PullRequestTimelineTab({
  revealUrl,
  onRevealSettled,
  scrollerRef,
  detail,
  environmentId,
  threadRef = null,
  reference,
  order,
  filter = SHOW_ALL_COMMENTS,
  onOpenCommit,
  onAddToChat,
  onRefresh,
  pendingFinding = null,
  fixFindingLabel,
  onFixFinding,
}: {
  /** A clicked link to scroll to and mark, until onRevealSettled reports it shown. */
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  scrollerRef: (node: HTMLElement | null) => void;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  reference: PullRequestRef;
  order: "newest" | "oldest";
  /** The saved comment filter: whether bot comments and finished conversations show. */
  filter?: PullRequestCommentFilter;
  onOpenCommit: (oid: string) => void;
  onAddToChat?: (subject: PullRequestChatSubject) => void;
  onRefresh: () => void;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const allEvents = buildPullRequestTimeline(detail, resolve);
  const location = parsePullRequestAnchor(revealUrl);
  const revealAnchor = location?.kind === "timeline" ? location.anchor : null;
  // The linked item stays marked and open after it is shown, until another link replaces it.
  const [linked, setLinked] = useState<{ readonly anchor: string; readonly count: number } | null>(
    () => (revealAnchor === null ? null : { anchor: revealAnchor, count: 1 }),
  );
  const [seenRevealUrl, setSeenRevealUrl] = useState(revealUrl);
  if (revealUrl !== seenRevealUrl) {
    setSeenRevealUrl(revealUrl);
    // Each click remounts the linked row, so it opens again even after the user closed it.
    if (revealAnchor !== null) setLinked({ anchor: revealAnchor, count: (linked?.count ?? 0) + 1 });
  }
  const anchor = linked
    ? resolvePullRequestReviewAnchor(linked.anchor, detail.comments, detail.reviewThreads)
    : null;
  const listRef = useRef<LegendListRef | null>(null);
  const matches = (event: PullRequestTimelineEvent) =>
    anchor !== null && pullRequestTimelineEventMatches(event, anchor);
  // A linked item shows even when the saved filter hides it, so the link always lands.
  const shown = new Set(filterPullRequestTimelineEvents(allEvents, filter));
  const events = allEvents.filter((event) => shown.has(event) || matches(event));

  const term = changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest);
  const newestCommitAt = newestPullRequestCommitAt(detail.commits);
  const reactions: ReactionSurface = {
    revealAnchor: anchor,
    canReact: (event) =>
      event.comment !== undefined && canReactPullRequestComment(detail, event.comment),
    onAddToChat: onAddToChat && ((comment) => onAddToChat({ kind: "comment", comment })),
    environmentId,
    threadRef,
    reference,
    completionScope: pullRequestCompletionScope(detail, environmentId, reference),
    onRefresh,
    fix: onFixFinding && {
      findingFor: (event) => timelineFinding(detail, event),
      onFix: onFixFinding,
      pending: pendingFinding,
      label: fixFindingLabel ?? gt("Fix in a thread"),
    },
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
  const targetIndex = rows.findIndex((row) =>
    row.kind === "comments" ? row.events.some(matches) : matches(row.event),
  );
  const stopHolding = useRef<(() => void) | null>(null);
  const reveal = useEffectEvent(() => {
    const list = listRef.current;
    const url = revealUrl;
    if (url === undefined || revealAnchor === null || targetIndex < 0 || !list) return;
    stopHolding.current?.();
    void list.scrollToIndex({ index: targetIndex, viewPosition: 0, animated: false }).then(() => {
      const scroller = list.getScrollableNode();
      const node = scroller?.querySelector<HTMLElement>("[data-pr-link-target=true]");
      if (scroller && node) stopHolding.current = holdLinkedNodeInView(node, scroller, () => 16);
      onRevealSettled?.(url);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals a link destination after activity loading and virtual list mounting
  useEffect(() => {
    reveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- runs for each clicked link and again when activity resolves its row
  }, [revealUrl, targetIndex]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the hold observes DOM outside React and must end with the tab
  useEffect(() => () => stopHolding.current?.(), []);
  const openOnHost = (url: string) => {
    void readLocalApi()?.shell.openExternal(url);
  };

  const rowKey = (row: PullRequestTimelineRow) => {
    if (row.kind === "comments")
      return `comments:${row.events[0]?.id ?? "empty"}:${row.events.some(matches) ? (linked?.count ?? "") : ""}`;
    const event = row.event;
    // A thread's resolution or dismissal remounts it, so its disclosure starts in the new state.
    return event.thread === undefined
      ? `${event.id}:${matches(event) ? (linked?.count ?? "") : ""}`
      : `thread:${event.id}:${matches(event) ? (linked?.count ?? "") : ""}:${event.thread.isResolved}:${pullRequestReviewOutcome(event.reviewState) === "dismissed"}`;
  };
  const renderRow = ({ item: row }: { item: PullRequestTimelineRow }) => {
    if (row.kind === "comments") {
      return (
        <ConversationGroup
          events={row.events}
          revealAnchor={anchor}
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
          event={event}
          thread={event.thread}
          detail={detail}
          revealAnchor={anchor}
          editable={editable}
          cwd={detail.workspaceRoot}
          onOpen={openOnHost}
          reactions={reactions}
        />
      );
    }
    if (event.kind === "commit") return <CommitEvent event={event} onOpen={onOpenCommit} />;
    const outcome = pullRequestReviewOutcome(event.reviewState);
    if (outcome !== null) {
      return (
        <ReviewVerdictEvent
          event={event}
          outcome={outcome}
          stale={isPullRequestVerdictStale(event.at, newestCommitAt)}
          cwd={detail.workspaceRoot}
          onOpen={openOnHost}
          reactions={reactions}
        />
      );
    }
    return <LifecycleEvent event={event} term={term} />;
  };

  if (events.length === 0) {
    return (
      <div ref={scrollerRef} className="h-full overflow-y-auto px-4.5 py-5">
        <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
          <PullRequestGlyph.pullRequest className="mb-2 size-5" />
          <p className="text-ui">
            <T>No activity yet.</T>
          </p>
        </div>
      </div>
    );
  }

  // Virtualized: a large pull request has thousands of events, and mounting every one stalls
  // the page. The connector line is drawn by the content container, behind the rows.
  return (
    <LegendList<PullRequestTimelineRow>
      ref={(list: LegendListRef | null) => {
        listRef.current = list;
        scrollerRef(list?.getScrollableNode() ?? null);
      }}
      data={rows}
      extraData={{ editable, reactions, newestCommitAt }}
      keyExtractor={rowKey}
      renderItem={renderRow}
      estimatedItemSize={140}
      className="h-full px-4.5"
      contentContainerClassName="relative w-full before:absolute before:top-7.5 before:bottom-10.5 before:left-3 before:w-px before:-translate-x-1/2 before:bg-(--shell-divider)"
      ListHeaderComponent={
        anchor !== null && targetIndex < 0 && revealUrl === undefined ? (
          <p role="status" className="py-4 text-xs text-muted-foreground">
            <T>The linked item is not in the loaded activity.</T>
          </p>
        ) : (
          // The first avatar sits 18px under the tab line, like its 18px side inset.
          <div className="h-2" />
        )
      }
      ListFooterComponent={<div className="h-1" />}
    />
  );
}
