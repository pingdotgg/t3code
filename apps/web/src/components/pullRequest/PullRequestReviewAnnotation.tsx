import type {
  EnvironmentId,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { CheckIcon, FileCodeIcon, HammerIcon, Trash2Icon } from "lucide-react";
import { Circle, CircleCheck } from "lucide";
import { useRef, useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { SpeechTextField, TextFieldSpeechControls } from "~/speech/useTextFieldSpeech";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { COMMENT_CARD_CLASS, CommentCardHead } from "../diffs/DiffCommentAnnotation";
import { Badge } from "../ui/badge";
import {
  editPullRequestThreadComment,
  mergePullRequestThreadComments,
} from "./pullRequestDetail.logic";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import type { PendingReviewComment } from "./pullRequestReviewStore";

/** Inset under the code like the thread diff's comments, on the same raised card. */
const CARD_CLASS = `mx-2.5 mt-1.5 mb-2 p-2.5 text-sm ${COMMENT_CARD_CLASS}`;

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
  onRemove,
}: {
  comment: PendingReviewComment;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(CARD_CLASS, "[--surface-tint-rim:var(--diff-comment-rim,var(--popover-rim))]")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CommentCardHead
        stateLabel={
          <Tooltip>
            <TooltipTrigger render={<Badge variant="secondary" />}>Pending</TooltipTrigger>
            <TooltipPopup side="top">Sent when you submit the review</TooltipPopup>
          </Tooltip>
        }
        action={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Discard this comment"
            onClick={onRemove}
          >
            <Trash2Icon className="size-3" />
          </Button>
        }
      />
      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
    </div>
  );
}

/** The file and line a thread sits on, and the last lines of code it was written against. */
function ReviewThreadLocation({ thread }: { thread: PullRequestReviewThread }) {
  const label = `${thread.path}${thread.line ? `:${thread.line}` : ""}`;
  return (
    <div className="-mx-3 -mt-3 mb-3 border-b border-border">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-kbd bg-secondary px-1.5 py-0.5 font-mono text-meta text-muted-foreground" />
            }
          >
            <FileCodeIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
        {thread.isOutdated ? <Badge variant="secondary">Outdated</Badge> : null}
        <Badge variant={thread.isResolved ? "success" : "warning"} className="ml-auto">
          {thread.isResolved ? "Resolved" : "Unresolved"}
        </Badge>
      </div>
      {thread.snippet && thread.snippet.length > 0 ? (
        <div className="mx-3 mb-3 overflow-x-auto rounded-md border border-border bg-background py-1 font-mono text-meta leading-5">
          {thread.snippet.map((line, index) => (
            <div
              // oxlint-disable-next-line react/no-array-index-key -- Snippet lines can repeat; these stateless rows never reorder.
              key={index}
              className={cn(
                "flex min-w-max gap-3 px-3",
                line.kind === "added" && "bg-success-tint",
                line.kind === "deleted" && "bg-error-tint",
              )}
            >
              <span className="w-8 shrink-0 text-right tabular-nums text-dim-foreground">
                {line.line ?? ""}
              </span>
              <span className="whitespace-pre text-foreground">{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  standalone = false,
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
}: {
  thread: PullRequestReviewThread;
  /**
   * Read away from the diff, in the Summary conversation: the card names its file and line,
   * shows the code it is about, and keeps a reply box open at its foot.
   */
  standalone?: boolean;
  workspaceRoot: string;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pending: boolean;
  fixPending?: boolean;
  fixLabel?: string;
  onFix?: () => void;
  onReply: (body: string) => Promise<boolean>;
  onLoadMore: (cursor: string) => Promise<PullRequestThreadCommentsResult | null>;
  canEditComment: (comment: PullRequestThreadComment) => boolean;
  onEditComment: (commentId: string, body: string) => Promise<boolean>;
  onToggleResolved: () => void;
  onReacted: () => void;
}) {
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const sendingRef = useRef(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
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
    if (trimmed.length === 0 || pending || sendingRef.current) return;
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
    setReplying(false);
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

  // Beside the reply field while the conversation is open; in the head otherwise, so a folded
  // or read-only thread can still be resolved or reopened.
  const resolveBesideReply = canResolve && expanded && canReply;
  const resolveButton = (
    <Button size="xs" variant="secondary" disabled={pending} onClick={onToggleResolved}>
      {thread.isResolved ? null : <CheckIcon />}
      {thread.isResolved ? "Unresolve" : "Resolve"}
    </Button>
  );

  if (standalone) {
    return (
      <div className="group rounded-card border border-border surface-card p-3 text-body">
        <ReviewThreadLocation thread={thread} />
        <div className="space-y-3">
          {comments.map((comment, index) => (
            <article key={comment.id} className={cn("group min-w-0", index > 0 && "ml-6")}>
              <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                <PullRequestActorLabel actor={comment.author} />
                <span>
                  <RelativeTime timestamp={comment.createdAt} />
                </span>
                {editingId === comment.id ? null : canEditComment(comment) ? (
                  <PullRequestEditButton
                    aria-label="Edit comment"
                    onClick={() => setEditingId(comment.id)}
                  />
                ) : null}
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
                <PullRequestMarkdown
                  className="mt-1 min-w-0 text-body"
                  text={comment.body}
                  cwd={workspaceRoot}
                  environmentId={environmentId}
                />
              )}
              <PullRequestReactionBar
                className="mt-1"
                reactions={comment.reactions ?? []}
                canReact={canReact}
                subjectId={comment.id}
                environmentId={environmentId}
                reference={reference}
                onRefresh={onReacted}
              />
            </article>
          ))}
        </div>
        {nextCommentsCursor !== null ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-2"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading..." : "Load more comments"}
          </Button>
        ) : null}
        {canReply || canResolve || onFix ? (
          <div className="mt-3 flex min-w-0 items-start gap-2">
            {canReply ? (
              <Textarea
                size="sm"
                rows={1}
                className="min-w-0 flex-1"
                value={reply}
                placeholder="Reply..."
                aria-label="Reply to this conversation"
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) =>
                  submitKeys({
                    value: reply,
                    pending,
                    onSubmit: () => void send(),
                    onCancel: () => setReply(""),
                  })(event)
                }
              />
            ) : (
              <span className="flex-1" />
            )}
            {canReply && reply.trim().length > 0 ? (
              <Button size="sm" disabled={pending} onClick={() => void send()}>
                Reply
              </Button>
            ) : null}
            {onFix ? (
              <Button size="sm" variant="ghost" disabled={pending || fixPending} onClick={onFix}>
                <HammerIcon className="size-3.5" />
                {fixPending ? "Preparing..." : fixLabel}
              </Button>
            ) : null}
            {canResolve ? (
              <Button size="sm" variant="secondary" disabled={pending} onClick={onToggleResolved}>
                <CheckIcon aria-hidden className="size-3.5" />
                {thread.isResolved ? "Unresolve" : "Resolve"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(CARD_CLASS, "[--surface-tint-rim:var(--popover-rim)]")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <MorphIcon
          className={cn("size-3.5", thread.isResolved && "text-success-foreground")}
          icon={thread.isResolved ? CircleCheck : Circle}
        />
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
        {canResolve && !resolveBesideReply ? (
          <Button
            size="xs"
            variant="ghost"
            className={onFix ? undefined : "ml-auto"}
            disabled={pending}
            onClick={onToggleResolved}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <div className="mt-2 space-y-3">
            {comments.map((comment) => (
              <article key={comment.id} className="group min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                  <PullRequestActorLabel actor={comment.author} />
                  <span>
                    <RelativeTime timestamp={comment.createdAt} />
                  </span>
                  <PullRequestReactionBar
                    className="ml-auto justify-end"
                    reactions={comment.reactions ?? []}
                    canReact={canReact}
                    subjectId={comment.id}
                    environmentId={environmentId}
                    reference={reference}
                    onRefresh={onReacted}
                  />
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
                  <div className="mt-1 flex items-start gap-1">
                    <PullRequestMarkdown
                      className="min-w-0 flex-1 text-body"
                      text={comment.body}
                      cwd={workspaceRoot}
                      environmentId={environmentId}
                    />
                    {canEditComment(comment) ? (
                      <PullRequestEditButton
                        aria-label="Edit comment"
                        onClick={() => setEditingId(comment.id)}
                      />
                    ) : null}
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
            // A reply field sits under every open conversation, with Resolve beside it. Focusing
            // it opens the full editor; Cancel or Escape folds it back, keeping what was written.
            replying ? (
              <SpeechTextField
                environmentId={environmentId}
                ownerKey={JSON.stringify(["pr-reply", environmentId, reference, thread.id])}
                text={reply}
                textareaRef={replyRef}
                onTextChange={setReply}
                disabled={pending}
              >
                {(speech) => (
                  <div className="mt-2 border-t border-border pt-2">
                    <Textarea
                      ref={replyRef}
                      readOnly={speech.freezesEditor}
                      autoFocus
                      size="sm"
                      value={reply}
                      placeholder="Reply…"
                      aria-label="Reply to this conversation"
                      onChange={(event) => setReply(event.target.value)}
                      onKeyDown={(event) =>
                        submitKeys({
                          value: reply,
                          pending: pending || speech.blocksSubmission,
                          onSubmit: () => void send(),
                          onCancel: () => setReplying(false),
                        })(event)
                      }
                    />
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <TextFieldSpeechControls speech={speech} disabled={pending} />
                      <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        disabled={pending || speech.blocksSubmission || reply.trim().length === 0}
                        onClick={() => void send()}
                      >
                        Reply
                      </Button>
                      {canResolve ? resolveButton : null}
                    </div>
                  </div>
                )}
              </SpeechTextField>
            ) : (
              <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
                <Input
                  className="min-w-0 flex-1"
                  size="compact"
                  readOnly
                  value={reply}
                  placeholder="Reply…"
                  aria-label="Reply to this conversation"
                  onFocus={() => setReplying(true)}
                />
                {canResolve ? resolveButton : null}
              </div>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
