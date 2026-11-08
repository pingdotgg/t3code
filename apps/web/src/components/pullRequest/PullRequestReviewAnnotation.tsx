import { aiReviewerOneLine } from "@t3tools/client-runtime/ai-reviewer-feedback";
import type {
  EnvironmentId,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { HammerIcon, MessageSquareIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import { Circle, CircleCheck } from "lucide";
import { useRef, useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";
import { SpeechTextField, TextFieldSpeechControls } from "~/speech/useTextFieldSpeech";

import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import {
  editPullRequestThreadComment,
  mergePullRequestThreadComments,
  visibleBody,
} from "./pullRequestDetail.logic";
import { pullRequestAiReviewerFeedback } from "./PullRequestAiReviewerFinding";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { PullRequestCommentBody } from "./PullRequestCommentBody";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import type { PendingReviewComment } from "./pullRequestReviewStore";
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
  onRemove,
}: {
  comment: PendingReviewComment;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(CARD_CLASS, "border-dashed")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>Pending. Sent when you submit the review</span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Discard this comment"
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
    </div>
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
  completionScope,
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
}: {
  thread: PullRequestReviewThread;
  workspaceRoot: string;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  completionScope: PullRequestCompletionScope | null;
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
}) {
  const rootFeedback = pullRequestAiReviewerFeedback(thread.comments[0] ?? { body: "" });
  // AI findings stay one line until opened; human threads still open when unresolved.
  const [expanded, setExpanded] = useState(!thread.isResolved && rootFeedback === null);
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
  const headerFeedback = pullRequestAiReviewerFeedback(comments[0] ?? { body: "" }) ?? rootFeedback;
  const headerLabel =
    headerFeedback !== null
      ? aiReviewerOneLine(headerFeedback)
      : `${thread.isResolved ? "Resolved" : "Open"} · ${commentCount} ${commentCount === 1 ? "comment" : "comments"}`;

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

  return (
    <div
      className={CARD_CLASS}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MorphIcon
          className={cn("size-3.5", thread.isResolved && "text-success-foreground")}
          icon={thread.isResolved ? CircleCheck : Circle}
        />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {headerLabel}
        </button>
        {thread.isOutdated ? <span>outdated</span> : null}
        {onFix ||
        (onAddToChat && comments.some((comment) => visibleBody(comment.body) !== null)) ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onFix ? (
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                disabled={pending || fixPending}
                onClick={onFix}
              >
                <HammerIcon />
                {fixPending ? "Preparing..." : fixLabel}
              </Button>
            ) : null}
            {onAddToChat && comments.some((comment) => visibleBody(comment.body) !== null) ? (
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                onClick={() => onAddToChat({ ...thread, comments })}
              >
                <MessageSquarePlusIcon />
                Add to chat
              </Button>
            ) : null}
          </div>
        ) : null}
        {canResolve ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
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
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
                    completionScope={completionScope}
                    label="Edit comment"
                    saving={savingEdit}
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
                      aiCollapsed={false}
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
            replying ? (
              <SpeechTextField
                environmentId={environmentId}
                projectId={reference.projectId}
                ownerKey={JSON.stringify(["pr-reply", environmentId, reference, thread.id])}
                text={reply}
                textareaRef={replyRef}
                onTextChange={setReply}
                disabled={pending}
              >
                {(speech) => (
                  <div className="mt-2">
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
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      <TextFieldSpeechControls speech={speech} disabled={pending} />
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
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setReplying(true)}>
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
