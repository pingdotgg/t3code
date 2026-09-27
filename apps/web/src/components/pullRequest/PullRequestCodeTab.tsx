import type {
  EnvironmentId,
  PullRequestActivity,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS } from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";
import { ToggleGroup } from "../ui/toggle-group";
import { pullRequestDiffInfiniteQueryOptions } from "~/lib/pullRequestReactQuery";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useTheme } from "~/hooks/useTheme";
import { useSettings } from "~/hooks/useSettings";
import { pullRequestInlineReviewSelection } from "./pullRequestInlineReviewSelection";
import {
  EMPTY_PENDING_REVIEW_COMMENTS,
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import { PullRequestActorLabel, toRenderablePullRequestMarkdown } from "./pullRequestPresentation";

type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
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
              <ChatMarkdown
                cwd={detail.workspaceRoot}
                text={toRenderablePullRequestMarkdown(comment.body)}
              />
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

type RenderablePullRequestPatch =
  | { readonly kind: "files"; readonly files: readonly FileDiffMetadata[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

function renderPullRequestPatch(patch: string, cacheKey: string): RenderablePullRequestPatch {
  const normalized = patch.trim();
  if (!normalized) return { kind: "files", files: [] };
  try {
    const files = parsePatchFiles(normalized, cacheKey).flatMap((parsed) => parsed.files);
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

export function PullRequestCodeTab({
  detail,
  reference,
  environmentId,
  commit,
  onCommitChange,
  onReply,
  onResolve,
  pending,
}: {
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
  readonly environmentId: EnvironmentId;
  readonly commit: string | null;
  readonly onCommitChange: (commit: string | null) => void;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  readonly pending: boolean;
}) {
  const diffQuery = useInfiniteQuery(
    pullRequestDiffInfiniteQueryOptions({
      environmentId,
      request: { ...reference, ...(commit ? { commit } : {}) },
    }),
  );
  const [inlineCommentBody, setInlineCommentBody] = useState("");
  const [inlineComment, setInlineComment] = useState<{
    readonly path: string;
    readonly line: number;
    readonly side: PullRequestDiffSide;
    readonly top: number;
    readonly left: number;
  } | null>(null);
  const key = pullRequestReviewKey(reference);
  const add = usePullRequestReviewStore((state) => state.add);
  const pendingReviewComments = usePullRequestReviewStore(
    (state) => state.commentsByKey[key] ?? EMPTY_PENDING_REVIEW_COMMENTS,
  );
  const { resolvedTheme } = useTheme();
  const pullRequestsCodeFontSize = useSettings((state) => state.pullRequestsCodeFontSize);
  const defaultWordWrap = useSettings((state) => state.diffWordWrap);
  const [diffWordWrap, setDiffWordWrap] = useState(defaultWordWrap);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const parsedPatchCache = useRef(new Map<string, RenderablePullRequestPatch>());
  const diffTextStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--diffs-font-size": `${pullRequestsCodeFontSize}px`,
        "--diffs-line-height": `${pullRequestsCodeFontSize + 8}px`,
      }) as CSSProperties,
    [pullRequestsCodeFontSize],
  );
  const diffOptions = useMemo(
    () => ({
      diffStyle,
      lineDiffType: "word" as const,
      hunkSeparators: "line-info" as const,
      overflow: diffWordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
    }),
    [diffStyle, diffWordWrap, resolvedTheme],
  );
  useEffect(() => {
    parsedPatchCache.current.clear();
  }, [key]);
  const renderablePages = useMemo(() => {
    return (diffQuery.data?.pages ?? []).map((page, index) => {
      const normalized = page.patch.trim();
      const cacheKey = buildPatchCacheKey(normalized, `${key}:${index}`);
      const cached = parsedPatchCache.current.get(cacheKey);
      if (cached !== undefined) {
        return {
          index,
          truncated: page.truncated,
          ...cached,
        };
      }
      const rendered = renderPullRequestPatch(normalized, cacheKey);
      parsedPatchCache.current.set(cacheKey, rendered);
      return {
        index,
        truncated: page.truncated,
        ...rendered,
      };
    });
  }, [diffQuery.data?.pages, key]);
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
  const threadByPath = useMemo(
    () =>
      detail.reviewThreads.reduce<Record<string, PullRequestReviewThread[]>>((threads, thread) => {
        (threads[thread.path] ??= []).push(thread);
        return threads;
      }, {}),
    [detail.reviewThreads],
  );
  const canComment =
    commit === null && detail.capabilities.review.inlineComment && detail.viewerPermissions.comment;

  const dismissInlineComment = useCallback(() => {
    setInlineComment(null);
    setInlineCommentBody("");
  }, []);

  useEffect(() => {
    if (!inlineComment) return;

    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Element) {
        if (event.target.closest("[data-pull-request-inline-comment]")) return;
      }
      dismissInlineComment();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissInlineComment();
    };

    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("scroll", dismissInlineComment, true);
    window.addEventListener("resize", dismissInlineComment);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("scroll", dismissInlineComment, true);
      window.removeEventListener("resize", dismissInlineComment);
    };
  }, [dismissInlineComment, inlineComment]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-chat-background">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        <select
          aria-label="Commit selection"
          className="h-7 min-w-0 max-w-[55%] rounded-sm bg-muted/40 px-2 text-xs"
          value={commit ?? ""}
          onChange={(event) => onCommitChange(event.currentTarget.value || null)}
        >
          <option value="">All commits</option>
          {commit && !detail.commits.some((entry) => entry.oid === commit) ? (
            <option value={commit}>{commit.slice(0, 7)}</option>
          ) : null}
          {detail.commits.map((entry) => (
            <option key={entry.oid} value={entry.oid}>
              {entry.oid.slice(0, 7)} {entry.messageHeadline}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {diffQuery.isPending
            ? "Loading…"
            : `${files.length}${diffQuery.hasNextPage ? "+" : ""} ${files.length === 1 ? "file" : "files"}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToggleGroup
            size="xs"
            value={[diffStyle]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "unified" || next === "split") setDiffStyle(next);
            }}
          >
            <Toggle aria-label="Unified diff view" size="xs" value="unified">
              <Rows3Icon className="size-3" />
            </Toggle>
            <Toggle aria-label="Split diff view" size="xs" value="split">
              <Columns2Icon className="size-3" />
            </Toggle>
          </ToggleGroup>
          <Toggle
            size="xs"
            aria-label="Wrap diff lines"
            pressed={diffWordWrap}
            onPressedChange={setDiffWordWrap}
          >
            <TextWrapIcon className="size-3" />
          </Toggle>
        </div>
      </div>
      {commit ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
          <span>Historical diff. Add line comments on the current PR diff.</span>
          <Button size="xs" variant="ghost" onClick={() => onCommitChange(null)}>
            Return to all commits
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <Virtualizer
          className="min-h-0 flex-1 overflow-auto overscroll-contain"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          {diffQuery.isPending ? (
            <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
          ) : null}
          {diffQuery.error ? (
            <div role="alert" className="space-y-2 p-4 text-sm text-destructive">
              <p>{errorMessage(diffQuery.error)}</p>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void (diffQuery.isFetchNextPageError
                    ? diffQuery.fetchNextPage()
                    : diffQuery.refetch())
                }
              >
                Retry
              </Button>
            </div>
          ) : null}
          {files.map(({ file, index, pageIndex, path: filePath }) => (
            <section
              className="border-b border-border/70 last:border-b-0"
              key={`${pageIndex}:${index}:${filePath}`}
            >
              <div
                onPointerUp={(event) => {
                  const selection = window.getSelection();
                  const anchor = pullRequestInlineReviewSelection(selection, event.currentTarget);
                  if (!canComment || !anchor || !selection || selection.rangeCount === 0) {
                    dismissInlineComment();
                    return;
                  }
                  const rect = selection.getRangeAt(0).getBoundingClientRect();
                  const popupWidth = Math.min(352, window.innerWidth - 16);
                  const popupHeight = 176;
                  const top =
                    rect.bottom + popupHeight + 8 <= window.innerHeight
                      ? rect.bottom + 8
                      : Math.max(8, rect.top - popupHeight - 8);
                  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8));
                  setInlineCommentBody("");
                  setInlineComment({
                    ...anchor,
                    path: filePath,
                    top,
                    left,
                  });
                }}
              >
                <FileDiff
                  fileDiff={file}
                  style={diffTextStyle}
                  options={{ ...diffOptions, collapsed: collapsedFiles.has(filePath) }}
                  renderHeaderPrefix={() => (
                    <button
                      aria-label={`${collapsedFiles.has(filePath) ? "Expand" : "Collapse"} ${filePath}`}
                      aria-expanded={!collapsedFiles.has(filePath)}
                      className="inline-flex size-5 items-center justify-center rounded-sm hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
                      type="button"
                      onClick={() =>
                        setCollapsedFiles((current) => {
                          const next = new Set(current);
                          if (next.has(filePath)) next.delete(filePath);
                          else next.add(filePath);
                          return next;
                        })
                      }
                    >
                      {collapsedFiles.has(filePath) ? (
                        <ChevronRightIcon className="size-4" />
                      ) : (
                        <ChevronDownIcon className="size-4" />
                      )}
                    </button>
                  )}
                />
              </div>
              {commit === null &&
              !collapsedFiles.has(filePath) &&
              threadByPath[filePath]?.length ? (
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
                <pre
                  className={
                    diffWordWrap
                      ? "max-h-120 overflow-auto p-3 leading-5 whitespace-pre-wrap wrap-break-word"
                      : "max-h-120 overflow-auto p-3 leading-5"
                  }
                  style={{ fontSize: pullRequestsCodeFontSize }}
                >
                  {page.text}
                </pre>
              </section>
            ))}
          {!diffQuery.isPending &&
          !diffQuery.error &&
          files.length === 0 &&
          !renderablePages.some((page) => page.kind === "raw") ? (
            <p className="p-4 text-sm text-muted-foreground">No diff available.</p>
          ) : null}
          {renderablePages.some((page) => page.truncated) ? (
            <p className="p-4 text-xs text-muted-foreground">
              Some files could not be rendered by GitHub.
            </p>
          ) : null}
          {diffQuery.hasNextPage ? (
            <div className="flex justify-center p-4">
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
        </Virtualizer>
        {canComment && inlineComment ? (
          <section
            aria-label={`Comment on ${inlineComment.path}:${inlineComment.line}`}
            className="fixed z-50 w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-2 shadow-lg"
            data-pull-request-inline-comment="true"
            role="dialog"
            style={{ left: inlineComment.left, top: inlineComment.top }}
          >
            <p className="truncate px-1 pb-1 text-[11px] text-muted-foreground">
              {inlineComment.path}:{inlineComment.line}
            </p>
            <Textarea
              aria-label="Review comment"
              autoFocus
              className="min-h-20"
              placeholder="Comment on selected code"
              size="sm"
              value={inlineCommentBody}
              onChange={(event) => setInlineCommentBody(event.currentTarget.value)}
            />
            <div className="mt-2 flex justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={dismissInlineComment}>
                Cancel
              </Button>
              <Button
                disabled={
                  !inlineCommentBody.trim() ||
                  pendingReviewComments.length >= MAX_PULL_REQUEST_INLINE_REVIEW_COMMENTS
                }
                size="xs"
                onClick={() => {
                  add(key, {
                    id: nextPendingReviewCommentId(),
                    path: inlineComment.path,
                    line: inlineComment.line,
                    side: inlineComment.side,
                    body: inlineCommentBody.trim(),
                  });
                  dismissInlineComment();
                  window.getSelection()?.removeAllRanges();
                }}
              >
                Add comment
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
