import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GitHubIssueDetail, GitHubIssueRef } from "@t3tools/contracts";
import {
  CircleDotIcon,
  CircleSlash2Icon,
  ExternalLinkIcon,
  GithubIcon,
  MessageSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { toastManager } from "../ui/toast";

export function GitHubIssueDetailPanel({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: GitHubIssueRef;
}) {
  const query = useEnvironmentQuery(
    githubIssueEnvironment.detail({ environmentId, input: reference }),
  );
  return (
    <GitHubIssueDetailContent
      environmentId={environmentId}
      detail={query.data}
      error={query.error}
      loading={query.isPending}
      onRetry={query.refresh}
    />
  );
}

export function GitHubIssueDetailContent({
  environmentId,
  detail,
  error,
  loading,
  onRetry,
}: {
  environmentId: EnvironmentId | null;
  detail: GitHubIssueDetail | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const newThread = useNewThreadHandler();
  const [preparing, setPreparing] = useState(false);

  const fixInThread = async () => {
    if (!detail || !environmentId || preparing) return;
    setPreparing(true);
    const opened = await newThread(scopeProjectRef(environmentId, detail.projectId)).catch(
      () => null,
    );
    if (opened === null) {
      setPreparing(false);
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project.",
      });
      return;
    }
    const prompt = [
      `Fix GitHub issue #${detail.number} in ${detail.repository}: ${detail.title}`,
      detail.url,
      "",
      "Read the issue and its discussion, reproduce the problem, implement the smallest complete fix, and run focused verification.",
    ].join("\n");
    useComposerDraftStore.getState().setPrompt(opened.draftId, prompt);
    setPreparing(false);
    toastManager.add({
      type: "success",
      title: "Issue ready in a thread",
      description: "The task is in the composer — read it over, then send.",
    });
  };

  if (loading && detail === null) {
    return <GitHubIssueDetailGhost />;
  }
  if (error && detail === null) {
    return (
      <GitHubIssueEmptyState
        title="Could not load this issue"
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }
  if (detail === null) {
    return (
      <GitHubIssueEmptyState
        title="Select an issue"
        description="Open an issue to read its description and discussion, then hand it to an agent."
      />
    );
  }

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
      {/* Both buttons are shrink-0, and the right panel leaves roughly 290px of content below
          760px, so on one row they would squeeze the title into a ribbon. The action group drops
          to its own line instead, the way the pull request panel gives its title a full row. */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <GitHubIssueStateIcon
            state={detail.state}
            className={cn(
              "mt-1 size-5 shrink-0",
              detail.state === "open" ? "text-success-foreground" : "text-muted-foreground",
            )}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-balance font-semibold text-xl leading-tight">{detail.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {detail.repository} #{detail.number} · opened by {detail.author?.login ?? "unknown"} ·{" "}
              {formatRelativeTimeLabel(detail.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void fixInThread()} disabled={preparing}>
            <WrenchIcon className="size-4" />
            {preparing ? "Preparing..." : "Fix in a thread"}
          </Button>
          <Button
            render={<a href={detail.url} target="_blank" rel="noreferrer noopener" />}
            size="icon-sm"
            variant="outline"
            aria-label="Open issue on GitHub"
          >
            <ExternalLinkIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {detail.labels.map((label) => (
          <span
            key={label.name}
            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
          >
            {label.name}
          </span>
        ))}
        {detail.assignees.map((assignee) => (
          <span
            key={assignee.login}
            className="rounded-full border border-border px-2 py-0.5 text-muted-foreground text-xs"
          >
            assigned to {assignee.login}
          </span>
        ))}
      </div>

      <section className="mt-6 rounded-xl border border-border/70 bg-card/30 p-4">
        {detail.body ? (
          <PullRequestMarkdown text={detail.body} cwd={detail.workspaceRoot} />
        ) : (
          <p className="text-muted-foreground text-sm">No description provided.</p>
        )}
      </section>

      <section className="mt-8">
        <h3 className="flex items-center gap-2 font-medium text-sm">
          <MessageSquareIcon className="size-4" /> Discussion ({detail.commentCount})
        </h3>
        <div className="mt-3 space-y-3">
          {detail.comments.map((comment) => (
            <div
              key={comment.id}
              className="rounded-xl border border-border/70 p-4 [contain-intrinsic-block-size:140px] [content-visibility:auto]"
            >
              <p className="mb-3 text-muted-foreground text-xs">
                {comment.author?.login ?? "unknown"} commented{" "}
                {formatRelativeTimeLabel(comment.createdAt)}
              </p>
              <PullRequestMarkdown text={comment.body} cwd={detail.workspaceRoot} />
            </div>
          ))}
          {detail.comments.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">No comments yet.</p>
          ) : null}
        </div>
      </section>
    </article>
  );
}

export function GitHubIssueStateIcon({
  state,
  className,
}: {
  state: GitHubIssueDetail["state"];
  className?: string;
}) {
  const Icon = state === "open" ? CircleDotIcon : CircleSlash2Icon;
  return <Icon className={className} />;
}

/**
 * Every empty answer this feature can give — the route's list and both detail surfaces — so the
 * two never drift apart. `Empty` owns the spacing between its slots, and `EmptyContent` is the
 * slot an action belongs in.
 */
export function GitHubIssueEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="min-h-72">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GithubIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
