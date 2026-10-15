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
  HammerIcon,
  ClockIcon,
  Trash2Icon,
} from "lucide-react";
import { Circle, CircleCheck } from "lucide";
import { useRef, useState } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MorphIcon } from "~/components/MorphIcon";
import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import {
  editPullRequestThreadComment,
  mergePullRequestThreadComments,
} from "./pullRequestDetail.logic";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import type { PendingReviewComment } from "./pullRequestReviewStore";

const CARD_CLASS =
  "mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm";

/** Sends a reply on ⌘/Ctrl+Enter and abandons it on Escape. */
function submitKeys(input: {
  readonly value: string;
  readonly pending: boolean;
  readonly onSubmit: () => void;
  readonly onCancel?: (() => void) | undefined;
}) {
  return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && input.onCancel) {
      event.preventDefault();
      input.onCancel();
    }
    if (isCommentSubmitShortcut(event, input.value, input.pending)) {
      event.preventDefault();
      input.onSubmit();
    }
  };
}

/** The contract's sides named the way the diff viewer names them, and back again. */
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

/** A comment waiting to be sent with the rest of the review. */
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
  const { busy, canSave, canDiscard, saveDraft, copyLink, discard } =
    usePendingReviewCommentActions(environmentId, reference);
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
  revealRequest?: number | undefined;
  onAddToComposer?: ((comment: PullRequestThreadComment) => void) | undefined;
}) {
  // A resolved thread is finished work, so it opens collapsed and stays one line until asked for.
  const [expanded, setExpanded] = useState(revealRequest !== undefined || !thread.isResolved);
  const [lastRevealRequest, setLastRevealRequest] = useState(revealRequest);
  if (lastRevealRequest !== revealRequest) {
    setLastRevealRequest(revealRequest);
    if (revealRequest !== undefined) setExpanded(true);
  }
  const [uploading, setUploading] = useState(false);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const [reply, setReply] = useState("");
  const [lastResolved, setLastResolved] = useState(thread.isResolved);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
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

  const send = async () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || pending || uploading || sendingRef.current) return;
    sendingRef.current = true;
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
      }
    } finally {
      sendingRef.current = false;
    }
  };
  const loadMore = async () => {
    if (nextCommentsCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await onLoadMore(nextCommentsCursor);
      if (page === null) return;
      setLoadedPage((previous) => ({
        threadId: thread.id,
        comments: mergePullRequestThreadComments(
          previous?.threadId === thread.id ? previous.comments : [],
          page.comments,
        ),
        nextCursor: page.nextCursor,
      }));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div
      data-review-thread-id={thread.id}
      className="mx-3 my-2 rounded-xl border border-border/70 bg-background text-sm shadow-sm"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" />}
            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <MorphIcon
              className={cn("size-3.5 shrink-0", thread.isResolved && "text-success-foreground")}
              icon={thread.isResolved ? CircleCheck : Circle}
            />
            <span className="truncate">
              {thread.isResolved
                ? expanded
                  ? "Collapse"
                  : collapsedLabel
                : `Open · ${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
            </span>
            {thread.line !== null && thread.startLine !== undefined ? (
              <span className="shrink-0">{reviewLineRangeLabel(thread)}</span>
            ) : null}
            {expanded ? (
              <ChevronUpIcon className="ml-auto size-3.5 shrink-0" />
            ) : (
              <ChevronDownIcon className="ml-auto size-3.5 shrink-0" />
            )}
          </TooltipTrigger>
          {thread.isResolved && !expanded ? <TooltipPopup>{collapsedLabel}</TooltipPopup> : null}
        </Tooltip>
        {onFix && (expanded || !thread.isResolved) ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={pending || fixPending}
            onClick={onFix}
          >
            <HammerIcon className="size-3" />
            {fixPending ? "Preparing..." : fixLabel}
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
                    <PullRequestCommentActions
                      body={comment.body}
                      url={comment.url ?? null}
                      onEdit={canEditComment(comment) ? () => setEditingId(comment.id) : undefined}
                      onAddToComposer={onAddToComposer ? () => onAddToComposer(comment) : undefined}
                      resolution={
                        canResolve
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
            <div
              data-review-reply-composer
              data-review-attachment-composer
              className="flex items-end gap-2 rounded-b-xl border-t border-border/70 bg-background px-3 py-3"
            >
              <textarea
                ref={replyInputRef}
                rows={1}
                disabled={pending || uploading}
                className="field-sizing-content min-h-6 min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
                style={{ maxHeight: "min(16rem,30vh)" }}
                value={reply}
                placeholder="Leave a reply…"
                aria-label="Reply to this conversation"
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={submitKeys({
                  value: reply,
                  pending: pending || uploading,
                  onSubmit: () => void send(),
                  onCancel: () => replyInputRef.current?.blur(),
                })}
              />
              <div className="flex h-6 shrink-0 items-center gap-1">
                <PullRequestAttachments
                  environmentId={environmentId}
                  reference={reference}
                  disabled={pending}
                  onBusyChange={setUploading}
                  textareaRef={replyInputRef}
                  onTextChange={setReply}
                />
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Send reply"
                  title="Send reply"
                  disabled={pending || uploading || reply.trim().length === 0}
                  onClick={() => void send()}
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
