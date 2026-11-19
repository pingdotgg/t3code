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
  HammerIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
  CircleCheckIcon,
  CircleIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { type ReactNode, useRef, useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";
import { SpeechTextField, TextFieldSpeechControls } from "~/speech/useTextFieldSpeech";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestEditButton } from "./PullRequestEditButton";
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
  const gt = useGT();
  return (
    <div
      className={cn(CARD_CLASS, "border-dashed")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>
          <T>Pending. Sent when you submit the review</T>
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label={gt("Discard this comment")}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
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
  const gt = useGT();
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
  const label = gt(
    "{count, plural, =1 {Resolved conversation} other {{count} resolved conversations}}",
    { count: resolved.length },
  );
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

/** The reply box under a review thread, with dictation; shared by the Code tab and the Timeline. */
export function PullRequestThreadReplyBox({
  className,
  environmentId,
  reference,
  threadId,
  completionScope,
  pending,
  value,
  onValueChange,
  onSend,
  onCancel,
}: {
  className?: string;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadId: string;
  completionScope: PullRequestCompletionScope | null;
  pending: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const gt = useGT();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  return (
    <SpeechTextField
      environmentId={environmentId}
      projectId={reference.projectId}
      ownerKey={JSON.stringify(["pr-reply", environmentId, reference, threadId])}
      text={value}
      textareaRef={replyRef}
      onTextChange={onValueChange}
      disabled={pending}
    >
      {(speech) => (
        <div className={className}>
          <PullRequestMarkdownTextarea
            ref={replyRef}
            readOnly={speech.freezesEditor}
            autoFocus
            size="sm"
            completionScope={completionScope}
            value={value}
            placeholder={gt("Reply", { $context: "noun, placeholder" })}
            aria-label={gt("Reply to this conversation")}
            onValueChange={onValueChange}
            onKeyDown={submitKeys({
              value,
              pending,
              allowEmpty: speech.blocksSubmission,
              onSubmit: () => speech.submitAfterDictation(onSend),
              onCancel: () => (speech.state.phase === "idle" ? onCancel() : speech.cancel()),
            })}
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <TextFieldSpeechControls speech={speech} disabled={pending} />
            <Button size="xs" variant="ghost" onClick={onCancel}>
              <T>Cancel</T>
            </Button>
            <Button
              size="xs"
              disabled={
                speech.preparing ||
                pending ||
                (!speech.blocksSubmission && value.trim().length === 0)
              }
              onClick={() => speech.submitAfterDictation(onSend)}
            >
              <T context="verb, button">Reply</T>
            </Button>
          </div>
        </div>
      )}
    </SpeechTextField>
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
  fixLabel,
  onFix,
  onAddToChat,
  onReply,
  onLoadMore,
  canEditComment,
  onEditComment,
  onToggleResolved,
  onReacted,
  hidden,
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
  /** Set on a diff line. Hidden draws nothing but stays mounted, so an unsent reply survives. */
  hidden?: boolean;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(hidden !== undefined || !thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
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

  if (hidden) return null;

  return (
    <div
      className={cn(CARD_CLASS, !expanded && "py-1")}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
          {thread.isResolved
            ? gt("Resolved", { $context: "review thread state" })
            : gt("Open", { $context: "review thread state" })}{" "}
          ·{" "}
          {gt("{count, plural, one {{count} comment} other {{count} comments}}", {
            count: commentCount,
          })}
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
            {fixPending ? gt("Preparing...") : (fixLabel ?? gt("Fix in a thread"))}
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
            <T>Add to chat</T>
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
            {thread.isResolved ? gt("Unresolve") : gt("Resolve")}
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
                    label={gt("Edit comment")}
                    saving={savingEdit}
                    onSave={(body) => void saveEdit(comment.id, body)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="mt-1 flex items-start gap-1">
                    <PullRequestMarkdown
                      className="min-w-0 flex-1 text-sm"
                      text={comment.body}
                      cwd={workspaceRoot}
                      environmentId={environmentId}
                    />
                    {canEditComment(comment) ? (
                      <PullRequestEditButton
                        aria-label={gt("Edit comment")}
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
                {loadingMore ? gt("Loading...") : gt("Load more comments")}
              </Button>
            </div>
          ) : null}

          {canReply ? (
            replying ? (
              <PullRequestThreadReplyBox
                className="mt-2"
                environmentId={environmentId}
                reference={reference}
                threadId={thread.id}
                completionScope={completionScope}
                pending={pending}
                value={reply}
                onValueChange={setReply}
                onSend={(text) => void send(text)}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setReplying(true)}>
                <T context="verb, button">Reply</T>
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
