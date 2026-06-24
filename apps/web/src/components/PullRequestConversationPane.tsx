import type { EnvironmentId } from "@t3tools/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FileCodeIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  SendIcon,
  TextIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { gitPrEnvironment, refreshPullRequestComments } from "~/state/gitPr";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

interface ActivityItem {
  id: string;
  kind: "description" | "issue" | "review";
  user: string;
  createdAt: string;
  body: string;
  path?: string;
  line?: number;
}

interface PullRequestConversationPaneProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
  authorLogin?: string | null | undefined;
  onJumpToFile?: ((filePath: string, line?: number) => void) | undefined;
}

function formatRelativeTime(value: string): string {
  if (!value) return "";
  const then = Date.parse(value);
  if (Number.isNaN(then)) return value;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

const KIND_CONFIG = {
  description: {
    label: "Description",
    Icon: TextIcon,
    className: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300",
  },
  issue: {
    label: "General comment",
    Icon: MessageCircleIcon,
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  },
  review: {
    label: "Inline comment",
    Icon: MessageSquareIcon,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
} as const;

function KindBadge({ kind }: { kind: ActivityItem["kind"] }) {
  const { label, Icon, className } = KIND_CONFIG[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

const ActivityEntry = memo(function ActivityEntry({
  item,
  onJumpToFile,
}: {
  item: ActivityItem;
  onJumpToFile?: ((filePath: string, line?: number) => void) | undefined;
}) {
  return (
    <article className="rounded-lg border border-border/70 bg-background p-3 shadow-sm">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <KindBadge kind={item.kind} />
        <span className="font-medium text-foreground">{item.user || "unknown"}</span>
        <span className="ml-auto tabular-nums">{formatRelativeTime(item.createdAt)}</span>
      </header>

      {item.kind === "review" && item.path && (
        <button
          type="button"
          onClick={() => onJumpToFile?.(item.path!, item.line)}
          className="mb-2 inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <FileCodeIcon className="size-3" aria-hidden="true" />
          {item.path}
          {item.line != null && <span>:{item.line}</span>}
        </button>
      )}

      {item.body.length > 0 ? (
        <div className="text-sm">
          <ChatMarkdown text={item.body} cwd={undefined} />
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">No description provided.</p>
      )}
    </article>
  );
});

function CommentComposer({
  environmentId,
  cwd,
  prNumber,
}: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
}) {
  const [draft, setDraft] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const postIssueComment = useAtomCommand(gitPrEnvironment.postPullRequestIssueComment, {
    reportFailure: false,
  });

  const handleSubmit = useCallback(() => {
    const body = draft.trim();
    if (!body || environmentId === null || cwd === null) return;
    setIsPending(true);
    setError(null);
    void postIssueComment({ environmentId, input: { cwd, prNumber, body } }).then((result) => {
      setIsPending(false);
      if (result._tag === "Success") {
        setDraft("");
        textareaRef.current?.focus();
        refreshPullRequestComments({ environmentId, cwd, prNumber });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Failed to post comment");
      }
    });
  }, [draft, postIssueComment, environmentId, cwd, prNumber]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="border-t border-border/70 bg-background p-3">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder="Leave a comment..."
        disabled={isPending}
        className={cn(
          "w-full resize-none rounded-md border border-border/70 bg-background p-2 text-sm outline-none",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
          "disabled:opacity-50",
        )}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {isPending ? "Posting..." : "Ctrl+Enter to submit"}
        </span>
        <div className="flex items-center gap-2">
          {error !== null && (
            <span className="text-xs text-destructive">{error ?? "Failed to post comment"}</span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={draft.trim().length === 0 || isPending}
          >
            {isPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <SendIcon className="size-3.5" aria-hidden="true" />
            )}
            Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

export const PullRequestConversationPane = memo(function PullRequestConversationPane({
  environmentId,
  cwd,
  prNumber,
  authorLogin,
  onJumpToFile,
}: PullRequestConversationPaneProps) {
  const queryTarget =
    environmentId !== null && cwd !== null
      ? { environmentId, input: { cwd, prNumber } }
      : null;

  const bodyQuery = useEnvironmentQuery(
    queryTarget ? gitPrEnvironment.pullRequestBody(queryTarget) : null,
  );
  const issueCommentsQuery = useEnvironmentQuery(
    queryTarget ? gitPrEnvironment.pullRequestIssueComments(queryTarget) : null,
  );
  const reviewCommentsQuery = useEnvironmentQuery(
    queryTarget ? gitPrEnvironment.pullRequestReviewComments(queryTarget) : null,
  );

  const isLoading =
    bodyQuery.isLoading || issueCommentsQuery.isLoading || reviewCommentsQuery.isLoading;

  const activityItems = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];

    if (bodyQuery.data) {
      items.push({
        id: "description",
        kind: "description",
        user: authorLogin ?? "author",
        createdAt: "",
        body: bodyQuery.data.body ?? "",
      });
    }

    if (issueCommentsQuery.data?.comments) {
      for (const c of issueCommentsQuery.data.comments) {
        items.push({
          id: `issue:${c.id}`,
          kind: "issue",
          user: c.user,
          createdAt: c.createdAt,
          body: c.body,
        });
      }
    }

    if (reviewCommentsQuery.data?.comments) {
      for (const c of reviewCommentsQuery.data.comments) {
        items.push({
          id: `review:${c.id}`,
          kind: "review",
          user: c.user,
          createdAt: c.createdAt,
          body: c.body,
          path: c.path,
          line: c.line,
        });
      }
    }

    // Description always first, then chronological
    items.sort((a, b) => {
      if (a.kind === "description") return -1;
      if (b.kind === "description") return 1;
      if (!a.createdAt || !b.createdAt) return 0;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });

    return items;
  }, [bodyQuery.data, issueCommentsQuery.data, reviewCommentsQuery.data, authorLogin]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading activity...
          </div>
        ) : activityItems.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            No activity yet.
          </div>
        ) : (
          <div className="space-y-3">
            {activityItems.map((item) => (
              <ActivityEntry key={item.id} item={item} onJumpToFile={onJumpToFile} />
            ))}
          </div>
        )}
      </div>

      <CommentComposer environmentId={environmentId} cwd={cwd} prNumber={prNumber} />
    </div>
  );
});
