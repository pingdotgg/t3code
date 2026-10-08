import {
  type EnvironmentId,
  formatIssueReference,
  type IssueLinkedPullRequest,
  type IssueRelative,
  normalizeWorkItemLinkKey,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { openLinkInBrowser } from "~/lib/openIssueLink";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { Spinner } from "../ui/spinner";
import {
  type IssueTreeRoot,
  IssueTreePullRequestRows,
  IssueTreeRow,
  mergeIssueTrees,
} from "./IssueTree";

interface ThreadIssueTreesProps {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  linked: ReadonlyArray<ThreadIssueLink>;
  /** The project an issue is read through; null when none here can read it. */
  projectFor: (issue: ThreadIssueLink) => ProjectId | null;
  onOpen: (
    issue: ThreadIssueLink,
    relative: Pick<IssueRelative, "repository" | "number" | "url">,
  ) => void;
  /** Opens a pull request the tracker reports for an issue in a tree. */
  onOpenPullRequest: (link: IssueLinkedPullRequest) => void;
  /** Shown for an issue whose tree cannot be read; defaults to a plain row. */
  renderFallback?: (issue: ThreadIssueLink) => ReactNode;
  /** Controls for a linked issue, shown on its row. */
  renderActions?: (issue: ThreadIssueLink) => ReactNode;
  className?: string | undefined;
}

type TreeRead = { readonly detail: IssueTreeRoot | null; readonly pending: boolean };

/**
 * The issues linked to a thread as trees, one per top ancestor, so linked issues that share an
 * epic read as one piece of work. Trees are re-read from the tracker when the agent finishes a
 * turn — when it is likely to have split work into new sub-issues — and on a slow timer while
 * they are on screen.
 */
export function ThreadIssueTrees({
  environmentId,
  threadRef,
  linked,
  projectFor,
  onOpen,
  onOpenPullRequest,
  renderFallback,
  renderActions,
  className,
}: ThreadIssueTreesProps) {
  const running = threadRuntimeIsActive(useThreadShell(threadRef)?.runtime ?? null);
  const [refreshToken, setRefreshToken] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRefreshToken((token) => token + 1);
    wasRunning.current = running;
  }, [running]);

  const [reads, setReads] = useState<Record<string, TreeRead>>({});
  const report = useCallback((key: string, read: TreeRead) => {
    setReads((previous) =>
      previous[key]?.detail === read.detail && previous[key]?.pending === read.pending
        ? previous
        : { ...previous, [key]: read },
    );
  }, []);

  const byKey = useMemo(
    () => new Map(linked.map((issue) => [threadIssueKey(issue), issue])),
    [linked],
  );
  const readable = linked.filter((issue) => projectFor(issue) !== null);
  const trees = useMemo(
    () =>
      mergeIssueTrees(
        linked.flatMap((issue) => {
          const detail = reads[threadIssueKey(issue)]?.detail;
          return detail && projectFor(issue) !== null
            ? [
                {
                  provider: issue.provider,
                  linkKey: threadIssueKey(issue),
                  detail,
                },
              ]
            : [];
        }),
      ),
    [linked, projectFor, reads],
  );
  const unread = linked.filter(
    (issue) => projectFor(issue) === null || !reads[threadIssueKey(issue)]?.detail,
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {readable.map((issue) => (
        <LinkedIssueRead
          key={threadIssueKey(issue)}
          environmentId={environmentId}
          projectId={projectFor(issue)!}
          issue={issue}
          refreshToken={refreshToken}
          onRead={report}
        />
      ))}
      {trees.map((tree) => {
        const scopeIssue = byKey.get(tree.rows.find((row) => row.linkKey)!.linkKey!)!;
        return (
          <div
            key={tree.key}
            role="tree"
            aria-label={tree.rows[0]!.issue.title}
            className="space-y-0.5 rounded-lg border border-border/50 p-1"
          >
            {tree.rows.map((row) => {
              const linkedIssue = row.linkKey === null ? undefined : byKey.get(row.linkKey);
              return (
                <Fragment key={`${row.depth}:${row.issue.url}`}>
                  <div className="group relative">
                    <IssueTreeRow
                      row={{
                        issue: row.issue,
                        depth: row.depth,
                        current: linkedIssue !== undefined,
                      }}
                      repository={scopeIssue.repository}
                      referenceStyle={referenceStyleOf(scopeIssue)}
                      onOpen={(relative) => onOpen(scopeIssue, relative)}
                      onOpenCurrent={() =>
                        onOpen(linkedIssue ?? scopeIssue, linkedIssue ?? row.issue)
                      }
                    />
                    {linkedIssue && renderActions ? (
                      <div className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md bg-background opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-popup-open]]:opacity-100">
                        {renderActions(linkedIssue)}
                      </div>
                    ) : null}
                  </div>
                  <IssueTreePullRequestRows
                    links={row.issue.linkedPullRequests}
                    depth={row.depth}
                    onOpen={onOpenPullRequest}
                  />
                </Fragment>
              );
            })}
          </div>
        );
      })}
      {unread.map((issue) => {
        const key = threadIssueKey(issue);
        if (reads[key]?.pending) {
          return (
            <div
              key={key}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
            >
              <Spinner className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            </div>
          );
        }
        return (
          <div key={key}>
            {renderFallback?.(issue) ?? (
              <PlainIssueRow issue={issue} onOpen={() => openLinkInBrowser(issue.url)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function threadIssueKey(issue: ThreadIssueLink) {
  const key = normalizeWorkItemLinkKey(issue);
  return `${key.provider}:${key.url}`;
}

function referenceStyleOf(issue: ThreadIssueLink) {
  return issue.provider === "linear" ? ("key-number" as const) : ("hash" as const);
}

function PlainIssueRow({ issue, onOpen }: { issue: ThreadIssueLink; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60"
    >
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatIssueReference({ ...issue, referenceStyle: referenceStyleOf(issue) })}
      </span>
    </button>
  );
}

/** Reads one linked issue's tree and hands it up; the trees are drawn merged, above. */
function LinkedIssueRead({
  environmentId,
  projectId,
  issue,
  refreshToken,
  onRead,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  issue: ThreadIssueLink;
  refreshToken: number;
  onRead: (key: string, read: TreeRead) => void;
}) {
  const reference = useMemo(
    () => ({
      projectId,
      provider: issue.provider,
      repository: issue.repository,
      number: issue.number,
    }),
    [projectId, issue.provider, issue.repository, issue.number],
  );
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId, input: reference }),
  );
  const { refresh } = detailQuery;
  useLiveRefresh(detailQuery.isPending ? null : refresh, {
    key: `issue:${environmentId}:${projectId}:${issue.repository}#${issue.number}`,
  });
  const applied = useRef(refreshToken);
  useEffect(() => {
    if (applied.current === refreshToken) return;
    applied.current = refreshToken;
    refresh();
  }, [refresh, refreshToken]);

  const data = detailQuery.data ?? null;
  const detail =
    data !== null &&
    detailQuery.error === null &&
    data.provider === issue.provider &&
    normalizeWorkItemLinkKey(data).url === normalizeWorkItemLinkKey(issue).url
      ? data
      : null;
  const pending = data === null && detailQuery.isPending;
  const key = threadIssueKey(issue);
  useEffect(() => onRead(key, { detail, pending }), [detail, key, onRead, pending]);
  return null;
}
