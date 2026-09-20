/**
 * Pull-request-specific annotations: conversations already on the host and comments queued for
 * the review being written. New comment composition uses the shared diff annotation.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestDetailView,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  FileCode2Icon,
  CircleIcon,
  HammerIcon,
  MessageSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
import {
  editPullRequestThreadComment,
  mergePullRequestThreadComments,
} from "./pullRequestDetail.logic";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestCommentActions } from "./PullRequestCommentActions";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { usePullRequestReviewStore, type PendingReviewComment } from "./pullRequestReviewStore";

const CARD_CLASS =
  "mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm";

/** A comment waiting to be sent with the rest of the review. */
export function PendingReviewCommentCard({
  comment,
  reviewKey,
  onRemove,
  onEdit,
  environmentId,
  workspaceRoot,
  pending: actionPending,
}: {
  comment: PendingReviewComment;
  reviewKey: string;
  onRemove: () => void;
  onEdit: (body: string) => void;
  environmentId: EnvironmentId;
  workspaceRoot: string;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const submitting = usePullRequestReviewStore(
    (store) => store.submittingReviews[reviewKey] === true,
  );
  const pending = actionPending || submitting;
  const setCommentEditing = usePullRequestReviewStore((store) => store.setCommentEditing);
  const changeEditing = (next: boolean) => {
    if (
      next &&
      (actionPending || usePullRequestReviewStore.getState().submittingReviews[reviewKey])
    )
      return;
    setCommentEditing(reviewKey, comment.id, next);
    setEditing(next);
  };
  useEffect(
    () => () => setCommentEditing(reviewKey, comment.id, false),
    [reviewKey, comment.id, setCommentEditing],
  );
  return (
    <div
      className={cn(CARD_CLASS, "border-dashed")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>Pending — sent when you submit the review</span>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => changeEditing(true)}>
          Edit
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Discard this comment"
          disabled={pending}
          onClick={() => {
            if (actionPending || usePullRequestReviewStore.getState().submittingReviews[reviewKey])
              return;
            changeEditing(false);
            onRemove();
          }}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      {editing ? (
        <PullRequestMarkdownEditor
          className="mt-2"
          value={comment.body}
          cwd={workspaceRoot}
          environmentId={environmentId}
          label="Edit pending comment"
          saving={pending}
          onSave={(body) => {
            onEdit(body);
            changeEditing(false);
          }}
          onCancel={() => changeEditing(false)}
        />
      ) : (
        <PullRequestMarkdown
          className="mt-2"
          text={comment.body}
          cwd={workspaceRoot}
          environmentId={environmentId}
        />
      )}
    </div>
  );
}

/** A conversation already on the host, with whatever this host lets the reader do to it. */
export function ReviewThreadCard({
  thread,
  workspaceRoot,
  canReply,
  canResolve,
  canReact,
  environmentId,
  reference,
  pending,
  fixPending,
  fixLabel = "Fix in a thread",
  onFix,
  onReply,
  onLoadMore,
  canEditComment,
  onEditComment,
  onToggleResolved,
  onReacted,
  className,
}: {
  className?: string;
  thread: PullRequestReviewThread;
  workspaceRoot: string;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pending: boolean;
  /** True while this thread's own hand-off is preparing, so only its button says so. */
  fixPending?: boolean;
  fixLabel?: string;
  /** Absent where a thread is shown outside the pull request page's reach. */
  onFix?: () => void;
  /** Resolves to whether the host took it, so a reply that failed keeps the words it was given. */
  onReply: (body: string) => Promise<boolean>;
  /** Reads one more page only after the reader asks for it. */
  onLoadMore: (cursor: string) => Promise<PullRequestThreadCommentsResult | null>;
  /** Whether this reader wrote this remark, which is what rewriting one takes. */
  canEditComment: (comment: PullRequestThreadComment) => boolean;
  /** Resolves to whether the host took it, like `onReply`. */
  onEditComment: (commentId: string, body: string) => Promise<boolean>;
  onToggleResolved: () => void;
  onReacted: () => void;
}) {
  // A resolved thread is finished work, so it opens collapsed and stays one line until asked for.
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [loadedPage, setLoadedPage] = useState<
    (PullRequestThreadCommentsResult & { readonly threadId: string }) | null
  >(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const currentPage = loadedPage?.threadId === thread.id ? loadedPage : null;
  const comments = mergePullRequestThreadComments(thread.comments, currentPage?.comments ?? []);
  const nextCommentsCursor =
    currentPage === null ? (thread.nextCommentsCursor ?? null) : currentPage.nextCursor;
  const commentCount = thread.commentCount ?? comments.length;

  const saveEdit = async (commentId: string, body: string) => {
    if (savingEdit || pending) return;
    setSavingEdit(true);
    setError(null);
    try {
      if (!(await onEditComment(commentId, body))) {
        setError("Your comment could not be saved. Your draft is still here.");
        return;
      }
      setLoadedPage((previous) =>
        previous?.threadId === thread.id
          ? {
              ...previous,
              comments: editPullRequestThreadComment(previous.comments, commentId, body),
            }
          : previous,
      );
      setEditingId(null);
    } catch {
      setError("Your comment could not be saved. Your draft is still here.");
    } finally {
      setSavingEdit(false);
    }
  };

  const send = async (body: string) => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || pending || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    // Cleared only once the host has it. Otherwise a failed reply leaves an error toast and an
    // empty box, and the words have to be written again.
    try {
      if (await onReply(trimmed)) {
        // The mutation returns no comment. Keep what the reader loaded and reopen its cursor so
        // the new reply remains reachable without spending requests until they ask to load it.
        setLoadedPage((previous) =>
          previous?.threadId === thread.id
            ? {
                ...previous,
                nextCursor: previous.nextCursor ?? thread.nextCommentsCursor ?? null,
              }
            : previous,
        );
        setReply("");
        setReplying(false);
      } else {
        setError("Your reply could not be posted. Your draft is still here.");
      }
    } catch {
      setError("Your reply could not be posted. Your draft is still here.");
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };
  const loadMore = async () => {
    if (nextCommentsCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await onLoadMore(nextCommentsCursor);
      if (page === null) {
        setError("More comments could not be loaded. Try again.");
        return;
      }
      setLoadedPage((previous) => ({
        threadId: thread.id,
        comments: mergePullRequestThreadComments(
          previous?.threadId === thread.id ? previous.comments : [],
          page.comments,
        ),
        nextCursor: page.nextCursor,
      }));
    } catch {
      setError("More comments could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div
      className={cn(
        "mx-3 my-2 overflow-hidden rounded-lg border border-border/70 bg-background text-sm",
        className,
      )}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="flex min-w-0 flex-1 items-center gap-1.5" />}>
            {thread.path === null ? (
              <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <FileCode2Icon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="truncate font-mono">
              {thread.path ?? "General discussion"}
              {thread.line === null ? "" : `:${thread.line}`}
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            {thread.path ?? "General discussion"}
            {thread.line === null ? "" : `:${thread.line}`}
          </TooltipPopup>
        </Tooltip>
        {thread.isOutdated ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">Outdated</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        {thread.isResolved ? (
          <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")}
          />
          {thread.isResolved ? "Resolved" : "Open"} · {commentCount}{" "}
          {commentCount === 1 ? "comment" : "comments"}
        </button>
        {onFix ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={pending || savingEdit || sending || fixPending}
            onClick={onFix}
          >
            <HammerIcon className="size-3" />
            {fixPending ? "Preparing..." : fixLabel}
          </Button>
        ) : null}
        {canResolve ? (
          <Button
            size="xs"
            variant="ghost"
            className={onFix ? undefined : "ml-auto"}
            disabled={pending || savingEdit || sending || editingId !== null || replying}
            onClick={onToggleResolved}
          >
            {thread.isResolved ? "Reopen" : "Resolve"}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {expanded || editingId !== null || replying ? (
        <div hidden={!expanded}>
          <div className="divide-y divide-border/60">
            {comments.map((comment) => (
              <article key={comment.id} className="group min-w-0 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={comment.author} className="text-foreground" />
                  <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                  <span className="ml-auto">
                    <PullRequestCommentActions
                      comment={{ ...comment, path: thread.path }}
                      disabled={pending || savingEdit || sending || editingId !== null || replying}
                      {...(canEditComment(comment)
                        ? { onEdit: () => setEditingId(comment.id) }
                        : {})}
                    />
                  </span>
                </div>
                {editingId === comment.id ? (
                  <PullRequestMarkdownEditor
                    className="mt-1"
                    value={comment.body}
                    cwd={workspaceRoot}
                    environmentId={environmentId}
                    label="Edit comment"
                    saving={savingEdit || pending}
                    onSave={(body) => void saveEdit(comment.id, body)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="mt-1 flex items-start gap-1">
                    <PullRequestCommentBody
                      className="min-w-0 flex-1 text-sm"
                      text={comment.body}
                      cwd={workspaceRoot}
                      environmentId={environmentId}
                    />
                  </div>
                )}
                <PullRequestReactionBar
                  className="mt-2"
                  reactions={comment.reactions ?? []}
                  canReact={canReact && !pending && !savingEdit && !sending}
                  subjectId={comment.id}
                  environmentId={environmentId}
                  reference={reference}
                  onRefresh={onReacted}
                />
              </article>
            ))}
          </div>
          {nextCommentsCursor !== null ? (
            <div className="px-3 pb-2">
              <Button
                size="xs"
                variant="ghost"
                className="px-1"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading..." : "Load more comments"}
              </Button>
            </div>
          ) : null}

          {canReply ? (
            replying ? (
              <div className="border-t border-border/60 bg-muted/10 p-3">
                <PullRequestMarkdownEditor
                  value={reply}
                  cwd={workspaceRoot}
                  environmentId={environmentId}
                  label="Reply to this conversation"
                  placeholder="Write a reply…"
                  saving={pending || sending || savingEdit}
                  saveLabel="Reply"
                  onDraftChange={setReply}
                  onSave={(body) => void send(body)}
                  onCancel={() => setReplying(false)}
                />
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="mx-3 mb-3 mt-1 border border-border/60 text-muted-foreground"
                disabled={pending || savingEdit || sending || editingId !== null}
                onClick={() => setReplying(true)}
              >
                <MessageSquareIcon aria-hidden className="size-3" />
                {reply.trim() ? "Continue reply" : "Reply…"}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PullRequestThreadCard({
  detail,
  thread,
  environmentId,
  reference,
  pending = false,
  onRefresh,
  ...props
}: Pick<
  React.ComponentProps<typeof ReviewThreadCard>,
  "thread" | "environmentId" | "reference" | "className" | "fixPending" | "fixLabel" | "onFix"
> & {
  detail: PullRequestDetailView;
  pending?: boolean;
  onRefresh: () => void;
}) {
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const reply = useAtomCommand(pullRequestEnvironment.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const edit = useAtomCommand(pullRequestEnvironment.updateComment, { reportFailure: false });
  const load = useAtomCommand(pullRequestEnvironment.threadComments, { reportFailure: false });
  const run = async (title: string, command: () => Promise<{ readonly _tag: string }>) => {
    if (pending || writingRef.current) return false;
    writingRef.current = true;
    setWriting(true);
    try {
      if ((await command())._tag === "Failure") {
        toastManager.add({ type: "error", title });
        return false;
      }
      onRefresh();
      return true;
    } catch {
      toastManager.add({ type: "error", title });
      return false;
    } finally {
      writingRef.current = false;
      setWriting(false);
    }
  };
  return (
    <ReviewThreadCard
      {...props}
      thread={thread}
      environmentId={environmentId}
      reference={reference}
      workspaceRoot={detail.workspaceRoot}
      pending={pending || writing}
      canReply={
        detail.capabilities.review.reply &&
        detail.viewerPermissions.comment &&
        thread.canReply !== false
      }
      canResolve={
        detail.capabilities.review.resolve &&
        detail.viewerPermissions.resolve &&
        thread.canResolve !== false
      }
      canReact={detail.capabilities.reactions === true}
      onReply={(body) =>
        run("Reply could not be posted", () =>
          reply({ environmentId, input: { ...reference, threadId: thread.id, body } }),
        )
      }
      onToggleResolved={() =>
        void run("The conversation could not be updated", () =>
          resolve({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, { author: comment.author, kind: "review-comment" })
      }
      onEditComment={(commentId, body) =>
        run("The comment could not be saved", () =>
          edit({
            environmentId,
            input: { ...reference, commentId, threadId: thread.id, kind: "review-comment", body },
          }),
        )
      }
      onLoadMore={async (cursor) => {
        const result = await load({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        return result._tag === "Failure" ? null : result.value;
      }}
      onReacted={onRefresh}
    />
  );
}
