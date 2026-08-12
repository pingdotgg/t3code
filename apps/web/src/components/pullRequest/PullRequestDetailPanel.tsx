import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS } from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  pullRequestActivityQueryOptions,
  pullRequestCommentMutationOptions,
  pullRequestDetailQueryOptions,
  pullRequestDiffInfiniteQueryOptions,
  pullRequestInvalidateMutationOptions,
  pullRequestReplyToThreadMutationOptions,
  pullRequestRequestReviewersMutationOptions,
  pullRequestReviewerCandidatesQueryOptions,
  pullRequestRunActionMutationOptions,
  pullRequestSetThreadResolutionMutationOptions,
  pullRequestSubmitReviewMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { openExternalPullRequestLink } from "~/lib/openPullRequestLink";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useTheme } from "~/hooks/useTheme";

import {
  EMPTY_PENDING_REVIEW_COMMENTS,
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

type DetailTab = "summary" | "conversation" | "code";
type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

const TABS: readonly { readonly value: DetailTab; readonly label: string }[] = [
  { value: "summary", label: "Summary" },
  { value: "conversation", label: "Conversation" },
  { value: "code", label: "Code" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function isAvailableAction(detail: PullRequestDetailView, action: PullRequestAction): boolean {
  if (
    !detail.capabilities.actions.includes(action) ||
    !detail.viewerPermissions.actions.includes(action)
  ) {
    return false;
  }

  switch (action) {
    case "merge":
      return (
        detail.state === "open" &&
        !detail.isDraft &&
        detail.capabilities.mergeMethods.some((method) => detail.mergeCapabilities[method])
      );
    case "ready":
      return detail.state === "open" && detail.isDraft;
    case "draft":
      return detail.state === "open" && !detail.isDraft;
    case "close":
      return detail.state === "open";
    case "reopen":
      return detail.state === "closed";
  }
}

function toDetailView(
  detail: PullRequestDetail | undefined,
  activity: PullRequestActivity | undefined,
): PullRequestDetailView | null {
  if (!detail) return null;
  return {
    ...detail,
    ...(activity ?? {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    }),
    author: activity?.author ?? detail.author,
    reviewers: activity?.reviewers ?? detail.reviewers,
  };
}

function ReviewThread({
  thread,
  detail,
  pending,
  onReply,
  onResolve,
}: {
  readonly thread: PullRequestReviewThread;
  readonly detail: PullRequestDetailView;
  readonly pending: boolean;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
}) {
  const [reply, setReply] = useState("");
  const canReply = detail.capabilities.review.reply && detail.viewerPermissions.comment;
  const canResolve = detail.capabilities.review.resolve && detail.viewerPermissions.resolve;

  return (
    <article className="rounded-lg border border-border/70 bg-card p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {thread.isResolved ? (
          <CheckIcon className="size-3.5 text-emerald-500" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <span>
          {thread.isResolved ? "Resolved" : "Open"} · {thread.path}
          {thread.line ? `:${thread.line}` : ""}
          {thread.isOutdated ? " · outdated" : ""}
        </span>
        {canResolve ? (
          <Button
            className="ml-auto"
            disabled={pending}
            size="xs"
            variant="ghost"
            onClick={() => onResolve(thread.id, !thread.isResolved)}
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>
      <div className="mt-3 space-y-3">
        {thread.comments.map((comment) => (
          <div key={comment.id}>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <PullRequestActorLabel actor={comment.author} className="text-foreground" />
              <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
            </div>
            <div className="mt-1">
              <ChatMarkdown cwd={detail.workspaceRoot} text={comment.body} />
            </div>
          </div>
        ))}
      </div>
      {canReply ? (
        <div className="mt-3">
          <Textarea
            aria-label={`Reply to ${thread.path}`}
            disabled={pending}
            placeholder="Reply to this thread"
            size="sm"
            value={reply}
            onChange={(event) => setReply(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && reply.trim()) {
                event.preventDefault();
                void onReply(thread.id, reply.trim())
                  .then(() => setReply(""))
                  .catch(() => undefined);
              }
            }}
          />
          <div className="mt-2 flex justify-end">
            <Button
              disabled={pending || reply.trim().length === 0}
              size="xs"
              onClick={() =>
                void onReply(thread.id, reply.trim())
                  .then(() => setReply(""))
                  .catch(() => undefined)
              }
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function ReviewComposer({
  detail,
  reference,
  submitting,
  onSubmit,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly submitting: boolean;
  readonly onSubmit: (input: {
    readonly verdict: PullRequestReviewVerdict;
    readonly body: string;
    readonly comments: readonly PendingReviewComment[];
  }) => void;
}) {
  const key = pullRequestReviewKey(reference);
  const comments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const summary = usePullRequestReviewStore((state) => state.summariesByKey[key] ?? "");
  const remove = usePullRequestReviewStore((state) => state.remove);
  const setSummary = usePullRequestReviewStore((state) => state.setSummary);
  const canSubmit = detail.capabilities.review.verdicts.some((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );

  if (!canSubmit) return null;
  const hasContent = summary.trim().length > 0 || comments.length > 0;
  const submit = (verdict: PullRequestReviewVerdict) =>
    onSubmit({
      verdict,
      body: summary,
      comments,
    });

  return (
    <section className="rounded-lg border border-border/70 bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquareIcon className="size-4" />
        Review
        {comments.length > 0 ? (
          <span className="text-xs font-normal text-muted-foreground">
            {comments.length} pending line {comments.length === 1 ? "comment" : "comments"}
          </span>
        ) : null}
      </div>
      {comments.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {comments.map((comment) => (
            <li className="flex gap-2" key={comment.id}>
              <span className="min-w-0 flex-1 truncate">
                {comment.path}:{comment.line} — {comment.body}
              </span>
              <button
                aria-label={`Discard comment at ${comment.path}:${comment.line}`}
                className="text-destructive hover:underline"
                type="button"
                onClick={() => remove(key, comment.id)}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Textarea
        className="mt-3"
        disabled={submitting}
        placeholder="Leave a review summary"
        value={summary}
        onChange={(event) => setSummary(key, event.currentTarget.value)}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {detail.capabilities.review.verdicts
          .filter((verdict) => detail.viewerPermissions.verdicts.includes(verdict))
          .map((verdict) => (
            <Button
              disabled={submitting || (verdict !== "approve" && !hasContent)}
              key={verdict}
              size="xs"
              variant={verdict === "request-changes" ? "destructive" : "outline"}
              onClick={() => submit(verdict)}
            >
              {verdict === "approve"
                ? "Approve"
                : verdict === "request-changes"
                  ? "Request changes"
                  : "Comment"}
            </Button>
          ))}
      </div>
    </section>
  );
}

type RenderablePullRequestPatch =
  | { readonly kind: "files"; readonly files: readonly FileDiffMetadata[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

function renderPullRequestPatch(patch: string, cacheKey: string): RenderablePullRequestPatch {
  const normalized = patch.trim();
  if (!normalized) {
    return { kind: "files", files: [] };
  }
  try {
    const files = parsePatchFiles(normalized, buildPatchCacheKey(normalized, cacheKey)).flatMap(
      (parsed) => parsed.files,
    );
    return files.length > 0
      ? { kind: "files", files }
      : {
          kind: "raw",
          text: normalized,
          reason: "GitHub returned a diff format that could not be rendered.",
        };
  } catch {
    return {
      kind: "raw",
      text: normalized,
      reason: "This diff could not be parsed. Showing the raw patch.",
    };
  }
}

function pullRequestDiffPath(file: FileDiffMetadata): string {
  const path = file.name ?? file.prevName ?? "";
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function CodeTab({
  detail,
  reference,
  environmentId,
  onReply,
  onResolve,
  pending,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly environmentId: EnvironmentId;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  readonly pending: boolean;
}) {
  const diffQuery = useInfiniteQuery(
    pullRequestDiffInfiniteQueryOptions({ environmentId, request: reference }),
  );
  const [path, setPath] = useState("");
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<PullRequestDiffSide>("right");
  const [body, setBody] = useState("");
  const key = pullRequestReviewKey(reference);
  const add = usePullRequestReviewStore((state) => state.add);
  const pendingReviewComments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const { resolvedTheme } = useTheme();
  const renderablePages = useMemo(
    () =>
      (diffQuery.data?.pages ?? []).map((page, index) => ({
        index,
        truncated: page.truncated,
        ...renderPullRequestPatch(page.patch, `${key}:${index}`),
      })),
    [diffQuery.data?.pages, key],
  );
  const files = useMemo(
    () =>
      renderablePages.flatMap((page) =>
        page.kind === "files"
          ? page.files.map((file, index) => ({
              file,
              index,
              pageIndex: page.index,
              path: pullRequestDiffPath(file),
            }))
          : [],
      ),
    [renderablePages],
  );
  const filePaths = useMemo(
    () => [...new Set(files.map((file) => file.path).filter((filePath) => filePath.length > 0))],
    [files],
  );
  const threadByPath = useMemo(
    () =>
      detail.reviewThreads.reduce<Record<string, PullRequestReviewThread[]>>((threads, thread) => {
        (threads[thread.path] ??= []).push(thread);
        return threads;
      }, {}),
    [detail.reviewThreads],
  );
  const canComment = detail.capabilities.review.inlineComment && detail.viewerPermissions.comment;
  const commentLine = Number(line);
  const isValidCommentLine = Number.isSafeInteger(commentLine) && commentLine > 0;

  if (diffQuery.isPending) {
    return <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>;
  }
  if (diffQuery.error) {
    return <p className="p-4 text-sm text-destructive">{errorMessage(diffQuery.error)}</p>;
  }
  return (
    <div className="space-y-4 p-4">
      {canComment ? (
        <section className="rounded-lg border border-border/70 bg-card p-3">
          <p className="text-sm font-medium">Add a line comment to this review</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_5rem_7rem]">
            <input
              aria-label="File path"
              className="h-8 rounded border border-input bg-background px-2 text-sm"
              list="pull-request-diff-paths"
              placeholder="src/file.ts"
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
            />
            <input
              aria-label="Line number"
              className="h-8 rounded border border-input bg-background px-2 text-sm"
              inputMode="numeric"
              min="1"
              step="1"
              type="number"
              value={line}
              onChange={(event) => setLine(event.currentTarget.value)}
            />
            <select
              aria-label="Diff side"
              className="h-8 rounded border border-input bg-background px-2 text-sm"
              value={side}
              onChange={(event) => setSide(event.currentTarget.value as PullRequestDiffSide)}
            >
              <option value="right">New version</option>
              <option value="left">Old version</option>
            </select>
          </div>
          <datalist id="pull-request-diff-paths">
            {filePaths.map((filePath) => (
              <option key={filePath} value={filePath} />
            ))}
          </datalist>
          <Textarea
            className="mt-2"
            placeholder="Comment"
            size="sm"
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
          <div className="mt-2 flex justify-end">
            <Button
              disabled={
                !path.trim() ||
                !body.trim() ||
                !isValidCommentLine ||
                pendingReviewComments.length >= MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS
              }
              size="xs"
              onClick={() => {
                add(key, {
                  id: nextPendingReviewCommentId(),
                  path: path.trim(),
                  line: commentLine,
                  side,
                  body: body.trim(),
                });
                setBody("");
              }}
            >
              Add to review
            </Button>
          </div>
        </section>
      ) : null}
      {files.length > 0 ? (
        <Virtualizer
          className="max-h-[calc(100dvh-23rem)] overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          {files.map(({ file, index, pageIndex, path: filePath }) => (
            <section
              className="mb-3 overflow-hidden rounded-lg border border-border/70 last:mb-0"
              key={`${pageIndex}:${index}:${filePath}`}
            >
              <FileDiff
                fileDiff={file}
                options={{
                  diffStyle: "unified",
                  lineDiffType: "none",
                  overflow: "scroll",
                  theme: resolveDiffThemeName(resolvedTheme),
                  themeType: resolvedTheme,
                }}
              />
              {threadByPath[filePath]?.length ? (
                <div className="space-y-2 border-t border-border/70 p-3">
                  {threadByPath[filePath].map((thread) => (
                    <ReviewThread
                      detail={detail}
                      key={thread.id}
                      pending={pending}
                      thread={thread}
                      onReply={onReply}
                      onResolve={onResolve}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </Virtualizer>
      ) : null}
      {renderablePages
        .filter((page) => page.kind === "raw")
        .map((page) => (
          <section
            className="overflow-hidden rounded-lg border border-border/70"
            key={`raw:${page.index}`}
          >
            <p className="border-b border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {page.reason}
            </p>
            <pre className="max-h-120 overflow-auto p-3 text-xs leading-5">{page.text}</pre>
          </section>
        ))}
      {renderablePages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No diff available.</p>
      ) : null}
      {renderablePages.some((page) => page.truncated) ? (
        <p className="text-xs text-muted-foreground">Some files could not be rendered by GitHub.</p>
      ) : null}
      {diffQuery.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            disabled={diffQuery.isFetchingNextPage}
            size="sm"
            variant="outline"
            onClick={() => void diffQuery.fetchNextPage()}
          >
            {diffQuery.isFetchingNextPage ? "Loading files…" : "Load more files"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PullRequestDetailPanel({
  environmentId,
  reference,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("summary");
  const detailQuery = useQuery(pullRequestDetailQueryOptions({ environmentId, reference }));
  const activityQuery = useQuery(
    pullRequestActivityQueryOptions({
      environmentId,
      reference,
      enabled: tab !== "summary",
    }),
  );
  const [comment, setComment] = useState("");
  const [actionPending, setActionPending] = useState<PullRequestAction | null>(null);
  const detail = toDetailView(detailQuery.data, activityQuery.data);
  const runAction = useMutation(
    pullRequestRunActionMutationOptions({ environmentId, queryClient }),
  );
  const postComment = useMutation(
    pullRequestCommentMutationOptions({ environmentId, queryClient }),
  );
  const submitReview = useMutation(
    pullRequestSubmitReviewMutationOptions({ environmentId, queryClient }),
  );
  const reply = useMutation(
    pullRequestReplyToThreadMutationOptions({ environmentId, queryClient }),
  );
  const resolve = useMutation(
    pullRequestSetThreadResolutionMutationOptions({ environmentId, queryClient }),
  );
  const invalidate = useMutation(
    pullRequestInvalidateMutationOptions({ environmentId, queryClient }),
  );
  const reviewersQuery = useQuery(
    pullRequestReviewerCandidatesQueryOptions({
      environmentId,
      reference,
      enabled: detail?.capabilities.reviewers.listCandidates === true,
    }),
  );
  const requestReviewers = useMutation(
    pullRequestRequestReviewersMutationOptions({ environmentId, queryClient }),
  );

  const refresh = () => {
    void invalidate.mutateAsync({ reference }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not refresh",
        description: errorMessage(error),
      }),
    );
  };
  const performAction = async (action: PullRequestAction) => {
    if (!detail || actionPending) return;
    setActionPending(action);
    try {
      const mergeMethod =
        action === "merge"
          ? (detail.capabilities.mergeMethods.find((method) => detail.mergeCapabilities[method]) ??
            undefined)
          : undefined;
      await runAction.mutateAsync({
        ...reference,
        action,
        ...(mergeMethod ? { mergeMethod } : {}),
      });
      const successLabels: Record<PullRequestAction, string> = {
        close: "Pull request closed",
        draft: "Pull request converted to draft",
        merge: "Pull request merged",
        ready: "Pull request marked ready",
        reopen: "Pull request reopened",
      };
      toastManager.add({ type: "success", title: successLabels[action] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Pull request action failed",
        description: errorMessage(error),
      });
    } finally {
      setActionPending(null);
    }
  };
  const sendReply = async (threadId: string, body: string) => {
    try {
      await reply.mutateAsync({ ...reference, threadId, body });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not reply",
        description: errorMessage(error),
      });
      throw error;
    }
  };
  const toggleResolved = (threadId: string, resolved: boolean) => {
    void resolve.mutateAsync({ ...reference, threadId, resolved }).catch((error) =>
      toastManager.add({
        type: "error",
        title: "Could not update thread",
        description: errorMessage(error),
      }),
    );
  };

  if (detailQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading pull request…
      </div>
    );
  }
  if (detailQuery.error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{errorMessage(detailQuery.error)}</p>
        <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const availableActions = detail.capabilities.actions.filter((action) =>
    isAvailableAction(detail, action),
  );
  const tabs = detail.capabilities.diff ? TABS : TABS.filter((tab) => tab.value !== "code");
  const activeTab = tabs.some((item) => item.value === tab) ? tab : "summary";
  const reviewKey = pullRequestReviewKey(reference);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-4 py-3">
        <div className="flex gap-2">
          <PullRequestStateGlyph
            isDraft={detail.isDraft}
            mergeability={detail.mergeability}
            state={detail.state}
          />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            #{detail.number} {detail.title}
          </h1>
          <Button
            aria-label="Refresh pull request"
            size="icon-xs"
            variant="ghost"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3.5", invalidate.isPending && "animate-spin")} />
          </Button>
          <Button
            aria-label="Close pull request panel"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <PullRequestActorLabel actor={detail.author} />
          <span>
            {detail.headBranch} → {detail.baseBranch}
          </span>
          <PullRequestDiffStat additions={detail.additions} deletions={detail.deletions} />
          <a
            className="inline-flex items-center gap-1 hover:text-foreground"
            href={detail.url}
            onClick={(event) => {
              event.preventDefault();
              openExternalPullRequestLink(detail.url);
            }}
          >
            GitHub <ExternalLinkIcon className="size-3" />
          </a>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {availableActions.map((action) => (
            <Button
              disabled={actionPending !== null}
              key={action}
              size="xs"
              variant={action === "close" ? "destructive" : "outline"}
              onClick={() => void performAction(action)}
            >
              {actionPending === action ? (
                "Working…"
              ) : action === "merge" ? (
                <>
                  <GitMergeIcon className="size-3" />
                  Merge
                </>
              ) : (
                action
              )}
            </Button>
          ))}
        </div>
        <nav aria-label="Pull request detail tabs" className="mt-3 flex gap-1">
          {tabs.map((item) => (
            <button
              className={cn(
                "rounded px-2 py-1 text-xs",
                activeTab === item.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
              key={item.value}
              type="button"
              onClick={() => setTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === "summary" ? (
          <div className="space-y-5 p-4">
            <ChatMarkdown
              cwd={detail.workspaceRoot}
              text={detail.body || "_No description provided._"}
            />
            {detail.labels.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">Labels</h2>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.labels.map((label) => (
                    <span
                      className="rounded border border-border/70 px-2 py-0.5 text-xs"
                      key={label.name}
                      style={label.color ? { borderColor: `#${label.color}` } : undefined}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h2 className="text-sm font-medium">Checks</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {detail.checks.map((check) => (
                  <li className="flex items-center gap-2" key={check.name}>
                    <span
                      className={
                        check.status === "success"
                          ? "text-emerald-500"
                          : check.status === "failure"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      ●
                    </span>
                    {check.url ? (
                      <a
                        className="hover:underline"
                        href={check.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {check.name}
                      </a>
                    ) : (
                      check.name
                    )}
                    <span className="text-xs text-muted-foreground">{check.status}</span>
                  </li>
                ))}
                {detail.checks.length === 0 ? (
                  <li className="text-sm text-muted-foreground">No checks reported.</li>
                ) : null}
              </ul>
            </section>
            {detail.reviewers.length > 0 || detail.capabilities.reviewers.listCandidates ? (
              <section>
                <h2 className="text-sm font-medium">Reviewers</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {detail.reviewers.map((reviewer) => (
                    <span
                      className="inline-flex items-center rounded border border-border/70 px-2 py-1 text-xs"
                      key={reviewer.login}
                    >
                      <PullRequestActorLabel actor={reviewer} />
                    </span>
                  ))}
                  {reviewersQuery.data?.candidates.map((candidate) => (
                    <Button
                      disabled={
                        !detail.capabilities.reviewers.request ||
                        !detail.viewerPermissions.requestReviewers ||
                        requestReviewers.isPending
                      }
                      key={`${candidate.kind}:${candidate.id}`}
                      size="xs"
                      variant={candidate.isRequested ? "secondary" : "outline"}
                      onClick={() =>
                        void requestReviewers
                          .mutateAsync({
                            ...reference,
                            requested: !candidate.isRequested,
                            reviewers: [{ id: candidate.id, kind: candidate.kind }],
                          })
                          .catch((error) =>
                            toastManager.add({
                              type: "error",
                              title: "Could not update reviewer",
                              description: errorMessage(error),
                            }),
                          )
                      }
                    >
                      {candidate.isRequested ? "Requested: " : "Request: "}
                      {candidate.login}
                    </Button>
                  ))}
                  {reviewersQuery.isPending ? (
                    <span className="text-xs text-muted-foreground">Loading reviewers…</span>
                  ) : null}
                  {reviewersQuery.error ? (
                    <span className="text-xs text-destructive">
                      Could not load reviewer suggestions.
                    </span>
                  ) : null}
                </div>
              </section>
            ) : null}
            {detail.capabilities.comment && detail.viewerPermissions.comment ? (
              <section>
                <h2 className="text-sm font-medium">Comment</h2>
                <Textarea
                  className="mt-2"
                  placeholder="Leave a comment"
                  value={comment}
                  onChange={(event) => setComment(event.currentTarget.value)}
                />
                <div className="mt-2 flex justify-end">
                  <Button
                    disabled={postComment.isPending || !comment.trim()}
                    size="xs"
                    onClick={() => {
                      const submittedComment = comment.trim();
                      void postComment
                        .mutateAsync({ ...reference, body: submittedComment })
                        .then(() =>
                          setComment((current) => (current === submittedComment ? "" : current)),
                        )
                        .catch((error) =>
                          toastManager.add({
                            type: "error",
                            title: "Could not post comment",
                            description: errorMessage(error),
                          }),
                        );
                    }}
                  >
                    Comment
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
        {activeTab === "conversation" ? (
          <div className="space-y-4 p-4">
            {activityQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading conversation…</p>
            ) : null}
            {activityQuery.error ? (
              <div className="flex items-center gap-3 rounded border border-destructive/40 p-3 text-sm text-destructive">
                <span className="min-w-0 flex-1">
                  Could not load the full conversation: {errorMessage(activityQuery.error)}
                </span>
                <Button size="xs" variant="outline" onClick={() => void activityQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {detail.comments
              .filter((item) => item.kind !== "review-comment")
              .map((item) => (
                <article className="border-b border-border/60 pb-4" key={item.id}>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <PullRequestActorLabel actor={item.author} className="text-foreground" />
                    <span>{formatRelativeTimeLabel(item.createdAt)}</span>
                  </div>
                  <div className="mt-2 text-sm">
                    <ChatMarkdown cwd={detail.workspaceRoot} text={item.body} />
                  </div>
                </article>
              ))}
            {detail.commentsTruncated ? (
              <p className="text-xs text-muted-foreground">
                GitHub returned the most recent {detail.comments.length} of {detail.commentCount}{" "}
                conversation items.
              </p>
            ) : null}
            {detail.commits.length > 0 ? (
              <section>
                <h2 className="text-sm font-medium">Commits</h2>
                <ul className="mt-2 space-y-2">
                  {detail.commits.map((commit) => (
                    <li className="text-sm" key={commit.oid}>
                      <span className="font-mono text-xs text-muted-foreground">
                        {commit.oid.slice(0, 7)}
                      </span>{" "}
                      {commit.messageHeadline}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {detail.comments.every((item) => item.kind === "review-comment") ? (
              <p className="text-sm text-muted-foreground">No conversation yet.</p>
            ) : null}
          </div>
        ) : null}
        {activeTab === "code" ? (
          <CodeTab
            detail={detail}
            environmentId={environmentId}
            key={reviewKey}
            reference={reference}
            onReply={sendReply}
            onResolve={toggleResolved}
            pending={reply.isPending || resolve.isPending}
          />
        ) : null}
        <div className="p-4 pt-0">
          <ReviewComposer
            detail={detail}
            reference={reference}
            submitting={submitReview.isPending}
            onSubmit={({ verdict, body, comments }) =>
              void submitReview
                .mutateAsync({
                  ...reference,
                  verdict,
                  body,
                  comments: comments.map(({ id: _id, ...comment }) => comment),
                })
                .then(() => {
                  usePullRequestReviewStore.getState().removeSubmitted(
                    reviewKey,
                    comments.map((comment) => comment.id),
                  );
                  usePullRequestReviewStore.getState().clearSubmitted(reviewKey, body);
                  toastManager.add({ type: "success", title: "Review submitted" });
                })
                .catch((error) =>
                  toastManager.add({
                    type: "error",
                    title: "Could not submit review",
                    description: errorMessage(error),
                  }),
                )
            }
          />
        </div>
      </div>
    </section>
  );
}
