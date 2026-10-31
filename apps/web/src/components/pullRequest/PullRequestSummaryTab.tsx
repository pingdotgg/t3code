import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestComment,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  HammerIcon,
  ListFilterIcon,
  RefreshCwIcon,
  TagIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useRef, useState, type ReactNode } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestReviewOutcomeBadge,
} from "./pullRequestPresentation";
import { PullRequestLabelPicker } from "./PullRequestLabelPicker";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import {
  filterPullRequestConversationItems,
  isPullRequestCommentFinished,
  orderPullRequestComments,
  pagePullRequestConversationItems,
  pullRequestConversationItemComments,
  pullRequestConversationItems,
  pullRequestConversationSummary,
  pullRequestFindingKey,
  pullRequestReviewOutcome,
  visibleBody,
  type PullRequestConversationItem,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/pull-request-editing";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestMoreReplies } from "./PullRequestMoreReplies";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { PullRequestConversationGhost } from "./PullRequestGhosts";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll.logic";

function CommentIdentity({
  comment,
  detail,
}: {
  comment: PullRequestComment;
  detail: PullRequestDetailView;
}) {
  const actor = comment.author;
  const profileUrl = actor
    ? sourceControlClients.get(detail.provider).authorProfileUrl(actor.login, detail.url)
    : null;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-meta">
      <PullRequestActorLabel actor={actor} profileUrl={profileUrl} className="max-w-full" />
      <Tooltip>
        <TooltipTrigger
          render={
            comment.url ? (
              <a
                href={comment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground hover:underline"
              />
            ) : (
              <span className="text-muted-foreground" />
            )
          }
        >
          <time dateTime={comment.createdAt}>
            <RelativeTime timestamp={comment.createdAt} />
          </time>
        </TooltipTrigger>
        <TooltipPopup>
          {new Date(comment.createdAt).toLocaleString()}
          {comment.url ? " · Open comment on host" : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function CommentLocation({
  comment,
  thread,
}: {
  comment: PullRequestComment;
  thread: PullRequestReviewThread | undefined;
}) {
  const path = thread?.path ?? comment.path;
  if (!path) return null;
  const label = `${path}${thread?.line ? `:${thread.line}` : ""}`;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-mono" />}>{label}</TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {thread?.isOutdated ? <span className="shrink-0">Outdated</span> : null}
    </div>
  );
}

function reviewStateLabel(state: string): string {
  const words = state.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface CommentEditing {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly canEdit: (comment: PullRequestComment) => boolean;
  readonly editingId: string | null;
  readonly saving: boolean;
  readonly onEdit: (comment: PullRequestComment | null) => void;
  readonly onSave: (comment: PullRequestComment, body: string) => void;
}

function CommentBody({
  comment,
  editing,
  className,
}: {
  comment: PullRequestComment;
  editing: CommentEditing;
  className?: string | undefined;
}) {
  if (editing.editingId === comment.id) {
    return (
      <PullRequestMarkdownEditor
        className={className}
        value={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        threadRef={editing.threadRef}
        label="Edit comment"
        saving={editing.saving}
        onSave={(body) => editing.onSave(comment, body)}
        onCancel={() => editing.onEdit(null)}
      />
    );
  }
  return (
    <div className={cn("flex items-start gap-1", className)}>
      <PullRequestCommentBody
        key={comment.id}
        className="min-w-0 flex-1"
        text={comment.body}
        cwd={editing.cwd}
        environmentId={editing.environmentId}
        threadRef={editing.threadRef}
      />
      {editing.canEdit(comment) ? (
        <PullRequestEditButton aria-label="Edit comment" onClick={() => editing.onEdit(comment)} />
      ) : null}
    </div>
  );
}

function CollapsedComment({
  comment,
  editing,
  label,
  body,
  reactionBar,
  detail,
  thread,
  replyCount = 0,
  replies = null,
  moreReplies = null,
}: {
  comment: PullRequestComment;
  editing: CommentEditing;
  label: string;
  body: string | null;
  reactionBar: ReactNode;
  detail: PullRequestDetailView;
  thread: PullRequestReviewThread | undefined;
  replyCount?: number;
  replies?: ReactNode;
  moreReplies?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <article className="group rounded-card border border-border surface-card [contain-intrinsic-block-size:44px] [content-visibility:auto]">
        <div className="p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <CommentIdentity comment={comment} detail={detail} />
            {replyCount > 0 ? (
              <span className="shrink-0 py-1 text-meta text-muted-foreground">
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
            ) : null}
            <CollapsibleTrigger ref={statusTriggerRef} variant="muted">
              {label}
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
              />
            </CollapsibleTrigger>
            {reactionBar}
          </div>
          <CommentLocation comment={comment} thread={thread} />
          {!open && body ? (
            <CollapsibleTrigger
              className="mt-2 block w-full truncate text-left text-meta text-muted-foreground hover:text-foreground"
              onClick={() => statusTriggerRef.current?.focus({ preventScroll: true })}
            >
              {body
                .replace(/<!--[\s\S]*?-->/gu, "")
                .replace(/^\s*>?\s*\[!\w+\]\s*$/gmu, "")
                .replace(/!?(\[([^\]]+)\])\([^)]*\)/gu, "$2")
                .replace(/^[\s>#*-]+/gmu, "")
                .replace(/[*`]/gu, "")
                .replace(/\s+/g, " ")
                .trim()}
            </CollapsibleTrigger>
          ) : null}
        </div>
        <CollapsiblePanel>
          {open ? (
            <div className="px-3 pb-3">
              {body === null && !editing.canEdit(comment) ? null : (
                <CommentBody className="mt-2" comment={comment} editing={editing} />
              )}
              {replies ? <div className="mt-3">{replies}</div> : null}
            </div>
          ) : null}
        </CollapsiblePanel>
        {moreReplies ? <div className="px-3 pb-3">{moreReplies}</div> : null}
      </article>
    </Collapsible>
  );
}

function Section({
  title,
  count,
  meta,
  defaultOpen = true,
  keepMounted = false,
  actions,
  children,
}: {
  title: string;
  /** A number beside the title, such as how many remarks the conversation holds. */
  count?: number | undefined;
  /** A quiet summary at the heading's far end. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headingRef = useRef<HTMLDivElement>(null);
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-pull-request-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-pull-request-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        // Adjust before paint to keep the collapsed heading in place.
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(nextOpen);
  };
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpenWithScrollAnchor}
      render={<section aria-label={title} />}
      data-pull-request-summary-section
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full items-center bg-(--code-surface) pr-4"
      >
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-label text-foreground">
          <span>{title}</span>
          {count !== undefined ? (
            <span className="font-normal tabular-nums text-muted-foreground">
              {count.toLocaleString()}
            </span>
          ) : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {meta ? (
          <span className="shrink-0 truncate text-meta text-muted-foreground">{meta}</span>
        ) : null}
        {actions}
      </div>
      <CollapsiblePanel keepMounted={keepMounted}>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const COMMENT_PAGE = 10;

const COMMENT_FILTER_STORAGE_KEY = "t3code:pull-request-comment-filter:v1";
const CommentFilterSchema = Schema.Struct({ bots: Schema.Boolean, resolved: Schema.Boolean });
const DEFAULT_COMMENT_FILTER: typeof CommentFilterSchema.Type = { bots: false, resolved: false };

export function PullRequestSummaryTab({
  scrollerRef,
  readiness,
  environmentId,
  threadRef,
  reference,
  detail,
  activityPending,
  activityError,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onRefresh,
}: {
  scrollerRef?: (node: HTMLDivElement | null) => void;
  /** The readiness card: checks, reviews and conflicts over the merge. Built by the panel. */
  readiness?: ReactNode;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  activityPending: boolean;
  activityError: string | null;
  pendingFinding?: string | null;
  fixFindingLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onRefresh: () => void;
}) {
  const terminology = sourceControlClients.get(detail.provider).changeRequest;
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const shownConversations = shown.url === detail.url ? shown.count : COMMENT_PAGE;
  const [commentFilter, setCommentFilter] = useLocalStorage(
    COMMENT_FILTER_STORAGE_KEY,
    DEFAULT_COMMENT_FILTER,
    CommentFilterSchema,
  );
  const items = pullRequestConversationItems(detail.comments, detail.reviewThreads);
  const commentCount = items.reduce(
    (count, item) => count + pullRequestConversationItemComments(item).length,
    0,
  );
  // Filter whole conversations before promoting open threads, keeping human replies to bots.
  const filteredItems = filterPullRequestConversationItems(items, commentFilter);
  const filteredOutCount =
    commentCount -
    filteredItems.reduce(
      (count, item) => count + pullRequestConversationItemComments(item).length,
      0,
    );
  const conversation = pullRequestConversationSummary(detail);
  const pinnedIds = new Set(conversation.changeRequests.map((entry) => entry.comment.id));
  // A dismissed root belongs with the collapsed talk even if its thread is unresolved.
  const openThreadIds = new Set(
    filteredItems.flatMap((item) =>
      item.kind === "thread" && !isPullRequestCommentFinished(item.root, item.thread)
        ? [item.id]
        : [],
    ),
  );
  const openThreads = conversation.openThreads.filter((thread) => openThreadIds.has(thread.id));
  const promotedIds = new Set(openThreads.map((thread) => thread.id));
  const talkItems = filteredItems.filter((item) =>
    item.kind === "thread" ? !promotedIds.has(item.id) : !pinnedIds.has(item.id),
  );
  // Open threads lead, but share the same mounting budget as the remaining conversation.
  const visibleOpenThreads = openThreads.slice(0, shownConversations);
  const { shown: recentItems, hidden: hiddenTalkCount } = pagePullRequestConversationItems(
    talkItems,
    Math.max(0, shownConversations - visibleOpenThreads.length),
  );
  const hiddenConversationCount = openThreads.length - visibleOpenThreads.length + hiddenTalkCount;
  const [commentOrder, setCommentOrder] = useState<"newest" | "oldest">("newest");
  const visibleItems = orderPullRequestComments(recentItems, commentOrder);
  const showOldestCommentsButton =
    hiddenConversationCount > 0 ? (
      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        onClick={() => setShown({ url: detail.url, count: shownConversations + COMMENT_PAGE })}
      >
        Show {Math.min(hiddenConversationCount, COMMENT_PAGE)} more conversation
        {hiddenConversationCount === 1 ? "" : "s"} ({hiddenConversationCount} hidden)
      </Button>
    ) : null;
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const [threadPending, setThreadPending] = useState(false);
  const runThreadCommand = async (
    label: string,
    run: () => Promise<{ readonly _tag: string }>,
  ): Promise<boolean> => {
    if (threadPending) return false;
    setThreadPending(true);
    const result = await run();
    setThreadPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: label });
      return false;
    }
    onRefresh();
    return true;
  };
  const canReplyToThreads = detail.capabilities.review.reply && detail.viewerPermissions.comment;
  const canResolveThreads = detail.capabilities.review.resolve && detail.viewerPermissions.resolve;

  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const [bodyScope, setBodyScope] = useState<string | null>(null);
  const [bodySaving, setBodySaving] = useState(false);
  // Hosts can reuse comment ids across pull requests.
  const [commentScope, setCommentScope] = useState<{
    readonly pullRequest: string;
    readonly commentId: string;
  } | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const editingCommentId = commentScope?.pullRequest === detail.url ? commentScope.commentId : null;

  const saveBody = async (body: string) => {
    if (bodySaving) return;
    setBodySaving(true);
    const result = await update({ environmentId, input: { ...reference, body } });
    setBodySaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the description" });
      return;
    }
    setBodyScope(null);
    onRefresh();
  };

  const commentEditing: CommentEditing = {
    cwd: detail.workspaceRoot,
    environmentId,
    threadRef,
    canEdit: (comment) => canEditPullRequestComment(detail, comment),
    editingId: editingCommentId,
    saving: commentSaving,
    onEdit: (comment) =>
      setCommentScope(comment === null ? null : { pullRequest: detail.url, commentId: comment.id }),
    onSave: async (comment, body) => {
      if (commentSaving || comment.kind === "review") return;
      setCommentSaving(true);
      const result = await updateComment({
        environmentId,
        input: { ...reference, commentId: comment.id, kind: comment.kind, body },
      });
      setCommentSaving(false);
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not save the comment" });
        return;
      }
      setCommentScope(null);
      onRefresh();
    },
  };

  const reactionBarFor = (comment: PullRequestComment) => (
    <PullRequestReactionBar
      className="ml-auto justify-end"
      reactions={comment.reactions ?? []}
      canReact={detail.capabilities.reactions === true}
      subjectId={comment.id}
      environmentId={environmentId}
      reference={reference}
      onRefresh={onRefresh}
    />
  );

  const renderCommentCard = (
    comment: PullRequestComment,
    thread: PullRequestReviewThread | undefined,
    { reply = false, footer }: { reply?: boolean; footer?: ReactNode } = {},
  ) => {
    const body = visibleBody(comment.body);
    const outcome = pullRequestReviewOutcome(comment.reviewState);
    const finding: PullRequestFinding | null =
      reply ||
      (comment.kind !== "review" && comment.kind !== "review-comment") ||
      outcome === "approved"
        ? null
        : thread === undefined
          ? body === null
            ? null
            : { kind: "comment", comment }
          : { kind: "thread", thread };
    return (
      <article
        key={`${detail.url}:${comment.id}`}
        className="group rounded-card border border-border surface-card [contain-intrinsic-block-size:160px] [content-visibility:auto]"
      >
        <div className="flex flex-wrap items-baseline gap-2 rounded-t-card surface-selected-soft px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2 text-meta text-muted-foreground">
            <CommentIdentity comment={comment} detail={detail} />
            {outcome ? (
              <PullRequestReviewOutcomeBadge outcome={outcome} />
            ) : comment.reviewState ? (
              <span>{reviewStateLabel(comment.reviewState)}</span>
            ) : null}
          </div>
          {onFixFinding && finding ? (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0"
              disabled={pendingFinding !== null && pendingFinding !== undefined}
              onClick={() => onFixFinding(finding)}
            >
              <span className="inline-flex items-baseline gap-1">
                <HammerIcon className="size-3 self-center" />
                <span>
                  {pendingFinding === pullRequestFindingKey(finding)
                    ? "Preparing..."
                    : fixFindingLabel}
                </span>
              </span>
            </Button>
          ) : null}
          {reactionBarFor(comment)}
        </div>
        {reply ? null : (
          <div className="px-3">
            <CommentLocation comment={comment} thread={thread} />
          </div>
        )}
        {body === null && !commentEditing.canEdit(comment) ? null : (
          <CommentBody className="px-3 py-3" comment={comment} editing={commentEditing} />
        )}
        {footer}
      </article>
    );
  };

  const renderComment = (comment: PullRequestComment, footer?: ReactNode) =>
    renderCommentCard(comment, undefined, { footer });

  const renderThreadCard = (thread: PullRequestReviewThread) => (
    <ReviewThreadCard
      // Named with the pull request too: a thread id is the host's own.
      key={`${detail.url}:${thread.id}`}
      standalone
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      canReply={canReplyToThreads}
      canResolve={canResolveThreads && canResolvePullRequestThread(detail, thread)}
      canReact={detail.capabilities.reactions === true}
      environmentId={environmentId}
      reference={reference}
      pending={threadPending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      fixLabel={fixFindingLabel}
      {...(onFixFinding ? { onFix: () => onFixFinding({ kind: "thread", thread }) } : {})}
      onLoadMore={async (cursor): Promise<PullRequestThreadCommentsResult | null> => {
        const result = await loadThreadComments({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: "More comments could not be loaded" });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        runThreadCommand("Reply could not be posted", () =>
          replyToThread({ environmentId, input: { ...reference, threadId: thread.id, body } }),
        )
      }
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, {
          author: comment.author,
          kind: "review-comment",
          canEdit: comment.canEdit,
        })
      }
      onEditComment={(commentId, body) =>
        runThreadCommand("The comment could not be saved", () =>
          updateComment({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void runThreadCommand("The conversation could not be updated", () =>
          setThreadResolution({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
    />
  );

  const changeRequestCount = conversation.changeRequests.length;
  const unresolvedCount = openThreads.length;
  const conversationMeta =
    activityPending || activityError
      ? null
      : [
          changeRequestCount > 0
            ? `${changeRequestCount} ${changeRequestCount === 1 ? "change request" : "change requests"}`
            : null,
          unresolvedCount > 0 ? `${unresolvedCount} unresolved` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const renderItem = (item: PullRequestConversationItem) => {
    const comment = item.kind === "comment" ? item.comment : item.root;
    const thread = item.kind === "thread" ? item.thread : undefined;
    const replies =
      item.kind === "thread" && item.replies.length > 0 ? (
        <div className="ml-4 space-y-2 border-l-2 border-border/60 pl-3">
          {item.replies.map((reply) => renderCommentCard(reply, undefined, { reply: true }))}
        </div>
      ) : null;
    const moreReplies =
      item.kind === "thread" && item.hasMoreReplies ? <PullRequestMoreReplies {...item} /> : null;
    if (isPullRequestCommentFinished(comment, thread)) {
      return (
        <CollapsedComment
          key={`${detail.url}:${item.kind}:${item.id}`}
          comment={comment}
          editing={commentEditing}
          detail={detail}
          thread={thread}
          label={thread?.isResolved ? "Resolved" : "Review dismissed"}
          body={visibleBody(comment.body)}
          replyCount={item.kind === "thread" ? item.replies.length + item.moreReplies : 0}
          replies={replies}
          moreReplies={moreReplies}
          reactionBar={reactionBarFor(comment)}
        />
      );
    }
    if (item.kind === "comment") return renderCommentCard(comment, undefined);
    return (
      <div key={`${detail.url}:thread:${item.id}`} className="space-y-2">
        {renderCommentCard(comment, thread)}
        {replies}
        {moreReplies}
      </div>
    );
  };

  return (
    <div ref={scrollerRef} className="h-full overflow-y-auto" data-pull-request-summary-scroll>
      {readiness ? <section className="px-4 pt-3 pb-4">{readiness}</section> : null}

      <Section key={`description:${detail.url}`} title="Description" keepMounted>
        <div className="group">
          {bodyScope === detail.url ? (
            <PullRequestMarkdownEditor
              allowEmpty
              value={detail.body}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
              threadRef={threadRef}
              label={`${capitalizeTerm(terminology.singular)} description`}
              placeholder={`Describe this ${terminology.singular}`}
              saving={bodySaving}
              onSave={(body) => void saveBody(body)}
              onCancel={() => setBodyScope(null)}
            />
          ) : (
            <div className="flex items-start gap-1">
              <PullRequestMarkdown
                className="min-w-0 flex-1"
                text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
                threadRef={threadRef}
              />
              {canEditPullRequestChangeRequest(detail) ? (
                <PullRequestEditButton
                  aria-label="Edit description"
                  onClick={() => setBodyScope(detail.url)}
                />
              ) : null}
            </div>
          )}
        </div>
        {/* Labels ride under the description, where the pull request says what it is about. The
            row is shown empty only where a label could be put on it from here. */}
        {detail.labels.length > 0 || detail.capabilities.labels === true ? (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1 text-meta">
            <TagIcon aria-hidden className="mr-0.5 size-3.5 text-muted-foreground" />
            {detail.labels.map((label) => (
              <PullRequestLabelChip
                key={label.name}
                label={label}
                size="default"
                className="max-w-48"
              />
            ))}
            {detail.capabilities.labels === true ? (
              <PullRequestLabelPicker
                environmentId={environmentId}
                reference={reference}
                allowed={detail.viewerPermissions.labels !== false}
              />
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        key={`conversation:${detail.url}`}
        title="Conversation"
        count={
          activityPending || activityError ? undefined : Math.max(detail.commentCount, commentCount)
        }
        meta={conversationMeta}
        actions={
          <div className="flex shrink-0 items-center gap-1">
            <Menu>
              <MenuTrigger
                render={<Button size="xs" variant="ghost-muted" />}
                aria-label="Filter comments"
              >
                <ListFilterIcon aria-hidden className="size-3" />
                {filteredOutCount > 0 ? `${filteredOutCount} hidden` : "Filter"}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Show</MenuGroupLabel>
                  <MenuCheckboxItem
                    checked={commentFilter.bots}
                    closeOnClick={false}
                    onCheckedChange={(bots) => setCommentFilter((value) => ({ ...value, bots }))}
                  >
                    Bot comments
                  </MenuCheckboxItem>
                  <MenuCheckboxItem
                    checked={commentFilter.resolved}
                    closeOnClick={false}
                    onCheckedChange={(resolved) =>
                      setCommentFilter((value) => ({ ...value, resolved }))
                    }
                  >
                    Resolved or dismissed
                  </MenuCheckboxItem>
                </MenuGroup>
              </MenuPopup>
            </Menu>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={
                commentOrder === "newest"
                  ? "Show oldest comments first"
                  : "Show newest comments first"
              }
              onClick={() => setCommentOrder((value) => (value === "newest" ? "oldest" : "newest"))}
            >
              <ArrowDownUpIcon aria-hidden className="size-3" />
              {commentOrder === "newest" ? "Newest first" : "Oldest first"}
            </Button>
          </div>
        }
      >
        {activityPending ? (
          <PullRequestConversationGhost terminology={terminology} />
        ) : activityError ? (
          <PullRequestActivityUnavailableState
            compact
            error={activityError}
            term={terminology.singular}
            onRetry={onRefresh}
          />
        ) : (
          <>
            {detail.commentsTruncated ? (
              <p className="mb-2 rounded-md border border-warning/30 bg-warning-surface px-2 py-1.5 text-meta">
                This conversation is only partially loaded. {commentCount} comment
                {commentCount === 1 ? " is" : "s are"} loaded; open it on the host to read the rest.
              </p>
            ) : null}
            {items.length === 0 ? (
              <p className="py-2 text-meta text-muted-foreground">No comments yet.</p>
            ) : (
              <div className="space-y-3">
                {conversation.changeRequests.map((entry) => (
                  <div key={`pinned:${entry.comment.id}`}>
                    {renderComment(
                      entry.comment,
                      entry.openThreadCount > 0 || entry.reRequestedAt ? (
                        <div className="flex items-center gap-2 px-3 pb-3 text-meta text-muted-foreground">
                          {entry.openThreadCount > 0 ? (
                            <span className="inline-flex items-center gap-1.5">
                              <CornerDownRightIcon aria-hidden className="size-3.5" />
                              {entry.openThreadCount}{" "}
                              {entry.openThreadCount === 1 ? "thread" : "threads"} below
                            </span>
                          ) : null}
                          {entry.reRequestedAt ? (
                            <span className="ml-auto inline-flex items-center gap-1.5">
                              <RefreshCwIcon aria-hidden className="size-3" />
                              Re-requested <RelativeTime timestamp={entry.reRequestedAt} />
                            </span>
                          ) : null}
                        </div>
                      ) : null,
                    )}
                  </div>
                ))}
                {visibleOpenThreads.map(renderThreadCard)}
                {filteredItems.length === 0 && filteredOutCount > 0 ? (
                  <p className="py-2 text-meta text-muted-foreground">
                    {filteredOutCount === 1
                      ? "The only comment is hidden by the filter."
                      : `All ${filteredOutCount} comments are hidden by the filter.`}
                  </p>
                ) : null}
                {commentOrder === "oldest" ? showOldestCommentsButton : null}
                {visibleItems.map(renderItem)}
                {commentOrder === "newest" ? showOldestCommentsButton : null}
                {shownConversations > COMMENT_PAGE ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => setShown({ url: detail.url, count: COMMENT_PAGE })}
                  >
                    Show only {COMMENT_PAGE} recent conversations
                  </Button>
                ) : null}
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
