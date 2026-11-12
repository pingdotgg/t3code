import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useReviewThreadActions } from "./useReviewThreadActions";
import type { PullRequestDetail } from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { reviewLineRangeLabel } from "@t3tools/client-runtime/review-selection";
import { PullRequestAttachments } from "./PullRequestAttachments";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";
import { PullRequestCommentActions } from "./PullRequestCommentActions";
/**
 * Pull-request-specific annotations: conversations already on the host and comments queued for
 * the review being written. New comment composition uses the shared diff annotation.
 */
import type {
  EnvironmentId,
  PullRequestActor,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  HammerIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
  CircleCheckIcon,
  CircleIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Circle, CircleCheck } from "lucide-react";

import { cn } from "~/lib/utils";
import { SpeechTextField, TextFieldSpeechControls } from "~/speech/useTextFieldSpeech";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Badge } from "../ui/badge";
import { ReviewIcon as MorphIcon } from "~/components/ReviewIcon";
import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import {
  editPullRequestThreadComment,
  mergePullRequestThreadComments,
  visibleBody,
} from "./pullRequestDetail.logic";
import { PullRequestActorAvatar, PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { usePendingReviewComments, type PendingReviewComment } from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

const CARD_CLASS =
  "mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm";

function submitKeys(input: {
  readonly value: string;
  readonly pending: boolean;
  readonly allowEmpty?: boolean;
  readonly onSubmit: () => void;
  readonly onCancel?: (() => void) | undefined;
}) {
  return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && input.onCancel) {
      event.preventDefault();
      input.onCancel();
    }
    if (isCommentSubmitShortcut(event, input.value, input.pending, input.allowEmpty)) {
      event.preventDefault();
      input.onSubmit();
    }
  };
}

export function toViewerSide(side: PullRequestDiffSide) {
  return side === "left" ? ("deletions" as const) : ("additions" as const);
}

export function getReviewPositionAnchor(position: PullRequestReviewPosition): {
  line: number;
  side: PullRequestDiffSide;
} {
  switch (position.kind) {
    case "added":
      return { line: position.newLine, side: "right" };
    case "deleted":
      return { line: position.oldLine, side: "left" };
    case "context":
      return {
        line: position.side === "left" ? position.oldLine : position.newLine,
        side: position.side,
      };
  }
}

export function PendingReviewCommentCard({
  comment,
  environmentId,
  reference,
  canCopyLink,
  onAddToComposer,
}: {
  comment: PendingReviewComment;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  canCopyLink: boolean;
  onAddToComposer?: (() => void) | undefined;
}) {
  const [replyCommentId, setReplyCommentId] = useState<string | null>(null);
  const { busy, canSave, canDiscard, saveDraft, copyLink, discard } =
    usePendingReviewCommentActions(environmentId, reference);
  if (replyCommentId)
    return (
      <HostedReviewThreadCard
        environmentId={environmentId}
        reference={reference}
        commentId={replyCommentId}
      />
    );
  return (
    <div
      className={cn(CARD_CLASS, "border-dashed")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="warning" size="sm">
          <ClockIcon className="size-3" />
          Pending
        </Badge>
        <span>
          {comment.hostedComment
            ? "Saved on GitHub · private until submitted"
            : canCopyLink
              ? busy
                ? "Saving to GitHub…"
                : "Only saved in T3"
              : "Sent when you submit the review"}
        </span>
        {canCopyLink && canSave && !comment.hostedComment && !busy ? (
          <Button size="xs" variant="ghost" onClick={() => void saveDraft(comment)}>
            Retry save
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <PullRequestCommentActions
            body={comment.body}
            url={comment.hostedComment?.url ?? null}
            onCopyLink={canCopyLink && canSave ? () => copyLink(comment) : undefined}
            disabled={busy}
            onAddToComposer={onAddToComposer}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Discard this comment"
            disabled={busy || (comment.hostedComment !== undefined && !canDiscard)}
            onClick={() => void discard(comment)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
      {canCopyLink && canSave ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void (async () => {
              const hosted = comment.hostedComment ?? (await saveDraft(comment));
              if (hosted) setReplyCommentId(hosted.commentId);
            })();
          }}
        >
          Reply to conversation
        </Button>
      ) : null}
    </div>
  );
}

/** The conversations on one diff line. Resolved ones hide behind their authors' avatars. */
export function InlineReviewThreads({
  threads,
  renderThread,
}: {
  threads: ReadonlyArray<PullRequestReviewThread>;
  renderThread: (thread: PullRequestReviewThread, hidden: boolean) => ReactNode;
}) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  // A conversation seen open stays shown once resolved, so it does not vanish under the reader.
  const open = threads.filter((thread) => !thread.isResolved);
  if (open.some((thread) => !shown.has(thread.id))) {
    setShown(new Set([...shown, ...open.map((thread) => thread.id)]));
  }
  const resolved = threads.filter((thread) => thread.isResolved);
  const expanded = resolved.every((thread) => shown.has(thread.id));
  const authors = new Map<string, PullRequestActor | null>();
  for (const comment of resolved.flatMap((thread) => thread.comments)) {
    authors.set(comment.author?.login ?? "ghost", comment.author);
  }
  if (authors.size === 0) authors.set("ghost", null);
  const label =
    resolved.length === 1 ? "Resolved conversation" : `${resolved.length} resolved conversations`;
  return (
    <>
      {resolved.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-resolved-threads
                aria-label={label}
                aria-expanded={expanded}
                // Sits on the commented line, which is the row above this annotation.
                className="absolute right-3 bottom-full flex h-[var(--diffs-line-height,20px)] cursor-pointer items-center -space-x-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                contentEditable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() =>
                  setShown(new Set((expanded ? open : threads).map((thread) => thread.id)))
                }
              />
            }
          >
            {[...authors].slice(0, 3).map(([login, author]) => (
              <PullRequestActorAvatar
                key={login}
                actor={author}
                className="ring-1 ring-background"
              />
            ))}
          </TooltipTrigger>
          <TooltipPopup side="left">{label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threads.map((thread) => renderThread(thread, thread.isResolved && !shown.has(thread.id)))}
    </>
  );
}

export function ReviewThreadCard({
  thread,
  workspaceRoot,
  canReply,
  canResolve,
  canReact,
  environmentId,
  reference,
  completionScope = null,
  pending,
  fixPending,
  fixLabel = "Fix in a thread",
  onFix,
  onAddToChat,
  onReply,
  onLoadMore,
  canEditComment,
  onEditComment,
  onToggleResolved,
  onReacted,
  hidden,
  onAddToComposer,
  revealRequest,
}: {
  thread: PullRequestReviewThread;
  workspaceRoot: string;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  completionScope?: PullRequestCompletionScope | null;
  pending: boolean;
  fixPending?: boolean;
  fixLabel?: string;
  onFix?: () => void;
  /**
   * Absent where there is no composer beside the panel to add the conversation to. Handed the
   * thread with every comment the reader has loaded, not only the first page.
   */
  onAddToChat?: (thread: PullRequestReviewThread) => void;
  onReply: (body: string) => Promise<boolean>;
  onLoadMore: (cursor: string) => Promise<PullRequestThreadCommentsResult | null>;
  canEditComment: (comment: PullRequestThreadComment) => boolean;
  onEditComment: (commentId: string, body: string) => Promise<boolean>;
  onToggleResolved: () => void;
  onReacted: () => void;
  hidden?: boolean;
  revealRequest?: number | undefined;
  onAddToComposer?: ((comment: PullRequestThreadComment) => void) | undefined;
}) {
  // A resolved thread is finished work, so it opens collapsed and stays one line until asked for.
  const pendingActions = usePendingReviewCommentActions(environmentId, reference);
  const [expanded, setExpanded] = useState(
    hidden !== undefined || revealRequest !== undefined || !thread.isResolved,
  );
  const [lastRevealRequest, setLastRevealRequest] = useState(revealRequest);
  if (lastRevealRequest !== revealRequest) {
    setLastRevealRequest(revealRequest);
    if (revealRequest !== undefined) setExpanded(true);
  }
  const [uploading, setUploading] = useState(false);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [lastResolved, setLastResolved] = useState(thread.isResolved);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const sendingRef = useRef(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [loadedPage, setLoadedPage] = useState<
    (PullRequestThreadCommentsResult & { readonly threadId: string }) | null
  >(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const currentPage = loadedPage?.threadId === thread.id ? loadedPage : null;
  const receivedComments = mergePullRequestThreadComments(
    thread.comments,
    currentPage?.comments ?? [],
  );
  const pendingComments = usePendingReviewComments(reference, [
    { ...thread, comments: receivedComments },
  ]);
  const pendingById = new Map(
    pendingComments.flatMap((comment) =>
      comment.hostedComment ? [[comment.hostedComment.commentId, comment] as const] : [],
    ),
  );
  const comments = receivedComments.filter(
    (comment) => !comment.pendingReviewId || pendingById.has(comment.id),
  );
  const nextCommentsCursor =
    currentPage === null ? (thread.nextCommentsCursor ?? null) : currentPage.nextCursor;
  const commentCount = thread.commentCount ?? comments.length;
  const authors = [
    ...new Set(comments.map((comment) => comment.author?.name ?? comment.author?.login ?? "ghost")),
  ];
  const authorLabel =
    authors.length > 2
      ? `${authors.slice(0, 2).join(", ")} and ${authors.length - 2} more`
      : authors.join(" and ");
  const collapsedLabel = `${commentCount} resolved ${commentCount === 1 ? "comment" : "comments"}${authorLabel ? ` from ${authorLabel}` : ""}`;

  // Follow resolution changes from this client or GitHub while allowing a finished thread to
  // be opened manually. Failed resolve requests leave the current view and draft intact.
  if (lastResolved !== thread.isResolved) {
    setLastResolved(thread.isResolved);
    setExpanded(!thread.isResolved);
  }

  const saveEdit = async (commentId: string, body: string) => {
    if (savingEdit) return;
    setSavingEdit(true);
    const saved = await onEditComment(commentId, body);
    setSavingEdit(false);
    if (saved) {
      setLoadedPage((previous) =>
        previous?.threadId === thread.id
          ? {
              ...previous,
              comments: editPullRequestThreadComment(previous.comments, commentId, body),
            }
          : previous,
      );
      setEditingId(null);
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending || uploading || sendingRef.current) return;
    sendingRef.current = true;
    const result = await settlePromise(() => onReply(trimmed));
    sendingRef.current = false;
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    if (!result.value) return;
    // Replies return no comment; retain loaded data and reopen pagination for a later read.
    setLoadedPage((previous) =>
      previous?.threadId === thread.id
        ? {
            ...previous,
            nextCursor: previous.nextCursor ?? thread.nextCommentsCursor ?? null,
          }
        : previous,
    );
    setReply("");
  };
  const loadMore = async () => {
    if (nextCommentsCursor === null || loadingMore) return;
    setLoadingMore(true);
    const result = await settlePromise(() => onLoadMore(nextCommentsCursor));
    setLoadingMore(false);
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const page = result.value;
    if (page === null) return;
    setLoadedPage((previous) => ({
      threadId: thread.id,
      comments: mergePullRequestThreadComments(
        previous?.threadId === thread.id ? previous.comments : [],
        page.comments,
      ),
      nextCursor: page.nextCursor,
    }));
  };

  if (hidden) return null;

  return (
    <div
      className={cn(CARD_CLASS, !expanded && "py-1")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {thread.isResolved ? (
          <CircleCheckIcon className="size-3.5 text-success-foreground" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <button
          type="button"
          className="hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {thread.isResolved ? "Resolved" : "Open"} · {commentCount}{" "}
          {commentCount === 1 ? "comment" : "comments"}
        </button>
        {thread.isOutdated ? <span>outdated</span> : null}
        {onFix ? (
          <Button
            size="compact"
            variant="ghost"
            className="ml-auto"
            disabled={pending || fixPending}
            onClick={onFix}
          >
            <HammerIcon className="size-3" />
            {fixPending ? "Preparing..." : fixLabel}
          </Button>
        ) : null}
        {onAddToChat && comments.some((comment) => visibleBody(comment.body) !== null) ? (
          <Button
            size="compact"
            variant="ghost"
            className={onFix ? undefined : "ml-auto"}
            onClick={() => onAddToChat({ ...thread, comments })}
          >
            <MessageSquarePlusIcon className="size-3" />
            Add to chat
          </Button>
        ) : null}
        {canResolve ? (
          <Button
            size="compact"
            variant="ghost"
            className={onFix || onAddToChat ? undefined : "ml-auto"}
            disabled={pending}
            onClick={onToggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <div className="divide-y divide-border/70">
            {comments.map((comment, index) => (
              <article key={comment.id} className="group min-w-0 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={comment.author} />
                  <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                  {comment.pendingReviewId ? (
                    <Badge variant="warning" size="sm">
                      <ClockIcon className="size-3" />
                      Pending
                    </Badge>
                  ) : null}
                  {index === 0 && thread.isOutdated ? (
                    <Badge variant="warning" size="sm">
                      Outdated
                    </Badge>
                  ) : null}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <PullRequestReactionBar
                      reactions={comment.reactions ?? []}
                      canReact={canReact}
                      subjectId={comment.id}
                      environmentId={environmentId}
                      reference={reference}
                      onRefresh={onReacted}
                    />
                    {index === 0 && canResolve && !thread.isResolved && !comment.pendingReviewId ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Resolve conversation"
                        title="Resolve conversation"
                        disabled={pending}
                        onClick={onToggleResolved}
                      >
                        <CheckIcon className="size-4" />
                      </Button>
                    ) : null}
                    {comment.pendingReviewId &&
                    pendingById.has(comment.id) &&
                    pendingActions.canDiscard ? (
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Discard this comment"
                        disabled={pendingActions.busy}
                        onClick={() => void pendingActions.discard(pendingById.get(comment.id)!)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    ) : null}
                    <PullRequestCommentActions
                      body={comment.body}
                      url={comment.url ?? null}
                      onEdit={canEditComment(comment) ? () => setEditingId(comment.id) : undefined}
                      onAddToComposer={onAddToComposer ? () => onAddToComposer(comment) : undefined}
                      resolution={
                        canResolve && !thread.comments.some((entry) => entry.pendingReviewId)
                          ? { resolved: thread.isResolved, pending, onToggle: onToggleResolved }
                          : undefined
                      }
                    />
                  </div>
                </div>
                {editingId === comment.id ? (
                  <PullRequestMarkdownEditor
                    className="mt-1"
                    value={comment.body}
                    cwd={workspaceRoot}
                    environmentId={environmentId}
                    completionScope={completionScope}
                    label="Edit comment"
                    saving={savingEdit}
                    onSave={(body) => void saveEdit(comment.id, body)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="mt-2">
                    <PullRequestMarkdown
                      className="min-w-0 flex-1 text-sm"
                      text={comment.body}
                      cwd={workspaceRoot}
                      environmentId={environmentId}
                    />
                  </div>
                )}
              </article>
            ))}
          </div>
          {nextCommentsCursor !== null ? (
            <div className="mt-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading..." : "Load more comments"}
              </Button>
            </div>
          ) : null}

          {canReply ? (
            replying ? (
              <SpeechTextField
                environmentId={environmentId}
                projectId={reference.projectId}
                ownerKey={JSON.stringify(["pr-reply", environmentId, reference, thread.id])}
                text={reply}
                textareaRef={replyRef}
                onTextChange={setReply}
                disabled={pending || uploading}
              >
                {(speech) => (
                  <div data-review-reply-composer data-review-attachment-composer className="mt-2">
                    <PullRequestMarkdownTextarea
                      ref={replyRef}
                      readOnly={speech.freezesEditor}
                      autoFocus
                      size="sm"
                      completionScope={completionScope}
                      value={reply}
                      placeholder="Reply"
                      aria-label="Reply to this conversation"
                      onValueChange={setReply}
                      onKeyDown={submitKeys({
                        value: reply,
                        pending,
                        allowEmpty: speech.blocksSubmission,
                        onSubmit: () => speech.submitAfterDictation((text) => void send(text)),
                        onCancel: () =>
                          speech.state.phase === "idle" ? setReplying(false) : speech.cancel(),
                      })}
                    />
                    <PullRequestAttachments
                      environmentId={environmentId}
                      reference={reference}
                      disabled={pending || uploading}
                      onBusyChange={setUploading}
                      textareaRef={replyRef}
                      onTextChange={setReply}
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <TextFieldSpeechControls speech={speech} disabled={pending || uploading} />
                      <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        disabled={
                          speech.preparing ||
                          pending ||
                          (!speech.blocksSubmission && reply.trim().length === 0)
                        }
                        onClick={() => speech.submitAfterDictation((text) => void send(text))}
                      >
                        Reply
                      </Button>
                    </div>
                  </div>
                )}
              </SpeechTextField>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                data-review-reply-composer
                data-review-attachment-composer
                className="mt-2"
                onClick={() => setReplying(true)}
              >
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Shared cached queries keep a Guide or pending-comment conversation live after a reply. */
export function HostedReviewThreadCard({
  environmentId,
  reference,
  threadId,
  commentId,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadId?: string | undefined;
  commentId?: string | undefined;
}) {
  const target = { environmentId, input: reference };
  const detail = useEnvironmentQuery(pullRequestEnvironment.detail(target));
  const activity = useEnvironmentQuery(pullRequestEnvironment.activity(target));
  const thread = activity.data?.reviewThreads.find((entry) =>
    threadId ? entry.id === threadId : entry.comments.some((comment) => comment.id === commentId),
  );
  const refreshActivity = activity.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Re-read hosted activity when opening a newly saved comment's conversation.
  useEffect(() => {
    if (commentId) refreshActivity();
  }, [commentId, refreshActivity]);
  if (!thread || !detail.data)
    return (
      <div className="p-3 text-sm" role="status">
        {activity.error ??
          detail.error ??
          (activity.isPending || detail.isPending
            ? "Loading conversation…"
            : "This conversation is not available yet. Refresh to check again.")}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            activity.refresh();
            detail.refresh();
          }}
        >
          Refresh conversation
        </Button>
      </div>
    );
  return (
    <HostedReviewThreadContent
      environmentId={environmentId}
      reference={reference}
      detail={detail.data}
      thread={thread}
      onRefresh={activity.refresh}
    />
  );
}

function HostedReviewThreadContent({
  environmentId,
  reference,
  detail,
  thread,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  thread: PullRequestReviewThread;
  onRefresh: () => void;
}) {
  const actions = useReviewThreadActions(environmentId, reference, detail, onRefresh);
  return (
    <ReviewThreadCard
      {...actions(thread)}
      thread={thread}
      environmentId={environmentId}
      reference={reference}
      workspaceRoot={detail.workspaceRoot}
      canReact={detail.capabilities.reactions === true}
      onReacted={onRefresh}
    />
  );
}
