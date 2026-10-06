import type {
  EnvironmentId,
  IssueComment,
  IssueDetail,
  PullRequestActor,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon, TagIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestCommentBody } from "../pullRequest/PullRequestCommentBody";
import { IssueDetailGhost } from "../pullRequest/PullRequestGhosts";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { PullRequestReactionBar } from "../pullRequest/PullRequestReactions";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { openOnHostLabel } from "../pullRequest/pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
  PullRequestMetaLine,
} from "../pullRequest/pullRequestPresentation";
import { resolveIssueState } from "./issuePresentation";

const COMMENT_PAGE = 10;

function profileUrl(actor: PullRequestActor | null, issue: IssueDetail): string | null {
  if (issue.provider !== "github" || actor === null) return null;
  const path =
    actor.isBot || actor.login.endsWith("[bot]")
      ? `/apps/${encodeURIComponent(actor.login.replace(/\[bot\]$/, ""))}`
      : `/${encodeURIComponent(actor.login)}`;
  return new URL(path, issue.url).toString();
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

function IssueCommentCard({
  comment,
  issue,
  environmentId,
  threadRef,
  reference,
  onRefresh,
}: {
  comment: IssueComment;
  issue: IssueDetail;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  onRefresh: () => void;
}) {
  return (
    <article className="rounded-lg border border-border/60 bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]">
      <div className="flex flex-wrap items-start gap-2 rounded-t-lg bg-muted/25 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <PullRequestActorLabel
            actor={comment.author}
            profileUrl={profileUrl(comment.author, issue)}
            className="max-w-full"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                comment.url ? (
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground hover:underline"
                  />
                ) : (
                  <span className="text-muted-foreground" />
                )
              }
            >
              <time dateTime={comment.createdAt}>{formatRelativeTimeLabel(comment.createdAt)}</time>
            </TooltipTrigger>
            <TooltipPopup>{new Date(comment.createdAt).toLocaleString()}</TooltipPopup>
          </Tooltip>
          {comment.editedAt ? <span className="text-muted-foreground">edited</span> : null}
        </div>
        <PullRequestReactionBar
          className="ml-auto justify-end"
          reactions={comment.reactions}
          canReact={false}
          subjectId={comment.id}
          environmentId={environmentId}
          reference={reference}
          onRefresh={onRefresh}
        />
      </div>
      <PullRequestCommentBody
        className="px-3 py-3"
        text={comment.body.trim().length > 0 ? comment.body : "_No content._"}
        cwd={issue.workspaceRoot}
        environmentId={environmentId}
        threadRef={threadRef}
      />
    </article>
  );
}

function IssueConversation({
  issue,
  environmentId,
  threadRef,
  reference,
  onRefresh,
}: {
  issue: IssueDetail;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  onRefresh: () => void;
}) {
  // Keyed by the issue, so another issue in this panel starts at its own latest comments.
  const [shown, setShown] = useState({ url: issue.url, count: COMMENT_PAGE });
  const count = shown.url === issue.url ? shown.count : COMMENT_PAGE;
  const visible = issue.comments.slice(Math.max(0, issue.comments.length - count));
  const hidden = issue.comments.length - visible.length;
  const state = resolveIssueState(issue);

  return (
    <div className="h-full overflow-y-auto">
      <section className="space-y-2 px-4 pt-3 pb-4">
        <h1 className="text-base font-semibold leading-snug text-pretty">{issue.title}</h1>
        <PullRequestMetaLine className="flex-wrap text-xs text-muted-foreground">
          <span className={cn("inline-flex shrink-0 items-center gap-1", state.toneClassName)}>
            <state.Icon aria-hidden className="size-3.5" />
            {state.label}
          </span>
          <PullRequestActorLabel
            actor={issue.author}
            profileUrl={profileUrl(issue.author, issue)}
          />
          <span>opened {formatRelativeTimeLabel(issue.createdAt)}</span>
        </PullRequestMetaLine>
        {issue.assignees.length > 0 || issue.labels.length > 0 ? (
          <div className="space-y-1 pt-2">
            {issue.assignees.length > 0 ? (
              <MetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
                {issue.assignees.map((actor) => (
                  <PullRequestActorLabel
                    key={actor.login}
                    actor={actor}
                    profileUrl={profileUrl(actor, issue)}
                    className="mr-1.5"
                  />
                ))}
              </MetaRow>
            ) : null}
            {issue.labels.length > 0 ? (
              <MetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
                {issue.labels.map((label) => (
                  <PullRequestLabelChip key={label.name} label={label} size="default" />
                ))}
              </MetaRow>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="Description" className="space-y-3 border-t border-border/60 px-4 py-4">
        <PullRequestMarkdown
          text={issue.body.trim().length > 0 ? issue.body : "_No description provided._"}
          cwd={issue.workspaceRoot}
          environmentId={environmentId}
          threadRef={threadRef}
        />
        <PullRequestReactionBar
          reactions={issue.reactions}
          canReact={false}
          environmentId={environmentId}
          reference={reference}
          onRefresh={onRefresh}
        />
      </section>

      <section aria-label="Comments" className="space-y-3 border-t border-border/60 px-4 py-4">
        <h2 className="text-xs font-medium text-muted-foreground">
          Comments ({issue.commentCount.toLocaleString()})
        </h2>
        {issue.commentsTruncated ? (
          <p className="rounded-md border border-warning/30 bg-warning-surface px-2 py-1.5 text-xs">
            The most recent {issue.comments.length} comments are here; open the issue on the host to
            read the rest.
          </p>
        ) : null}
        {issue.comments.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          <>
            {hidden > 0 ? (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => setShown({ url: issue.url, count: count + COMMENT_PAGE })}
              >
                Show {Math.min(hidden, COMMENT_PAGE)} older comment{hidden === 1 ? "" : "s"} (
                {hidden} hidden)
              </Button>
            ) : null}
            {visible.map((comment) => (
              <IssueCommentCard
                key={`${issue.url}:${comment.id}`}
                comment={comment}
                issue={issue}
                environmentId={environmentId}
                threadRef={threadRef}
                reference={reference}
                onRefresh={onRefresh}
              />
            ))}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * A read-only issue beside a thread. An issue link that turns out to name a pull request hands
 * itself to `onPullRequest`, which opens the pull request view in its place.
 */
export function IssueDetailPanel({
  environmentId,
  threadRef,
  reference,
  url,
  onPullRequest,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  /** The link that opened this panel, for the way out while the issue cannot be read. */
  url: string | undefined;
  onPullRequest: (url: string) => void;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.issue({ environmentId, input: reference }),
  );
  const result = query.data;
  const issue = result?._tag === "issue" ? result.issue : null;
  const pullRequestUrl = result?._tag === "pull-request" ? result.url : null;

  useEffect(() => {
    if (pullRequestUrl !== null) onPullRequest(pullRequestUrl);
  }, [onPullRequest, pullRequestUrl]);

  const referenceKey = `${reference.projectId}:${reference.host ?? ""}:${reference.repository}#${reference.number}`;
  useLiveRefresh(() => query.refresh(), { key: `issue:${environmentId}:${referenceKey}` });

  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [isInvalidating, setIsInvalidating] = useState(false);
  const refreshing = isInvalidating || query.isPending;
  const refreshFromHost = async () => {
    setIsInvalidating(true);
    try {
      await invalidate({ environmentId, input: { reference } });
      query.refresh();
    } finally {
      setIsInvalidating(false);
    }
  };

  const repositoryUrl =
    issue?.provider === "github" ? issue.url.replace(/\/issues\/\d+(?:[/?#].*)?$/u, "") : null;
  const markdownContext = useMemo(() => ({ repositoryUrl, threadRef }), [repositoryUrl, threadRef]);

  if (issue === null) {
    if (query.error !== null && !query.isPending) {
      return (
        <PullRequestsUnavailableState
          title="Could not load issue"
          error={query.error}
          onRetry={() => void refreshFromHost()}
          refreshing={refreshing}
          {...(url === undefined ? {} : { gitHubUrl: url })}
        />
      );
    }
    return <IssueDetailGhost />;
  }

  const state = resolveIssueState(issue);
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-4 text-sm text-muted-foreground sm:text-xs">
        <span className="min-w-0 truncate font-medium">{issue.repository}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void readLocalApi()?.shell.openExternal(issue.url)}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                  state.toneClassName,
                )}
                aria-label={`Open issue #${issue.number} on host`}
              >
                #{issue.number}
                <ExternalLinkIcon aria-hidden className="size-2.5" />
              </button>
            }
          />
          <TooltipPopup side="top">{openOnHostLabel(issue.provider)}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="ml-auto"
                disabled={refreshing}
                aria-label="Refresh issue"
                onClick={() => void refreshFromHost()}
              />
            }
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
          </TooltipTrigger>
          <TooltipPopup side="top">Refresh issue</TooltipPopup>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1">
        <PullRequestMarkdownContext value={markdownContext}>
          <IssueConversation
            issue={issue}
            environmentId={environmentId}
            threadRef={threadRef}
            reference={reference}
            onRefresh={() => query.refresh()}
          />
        </PullRequestMarkdownContext>
      </div>
    </div>
  );
}
