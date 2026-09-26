import {
  type IssueKey,
  type IssueLinkChange,
  IssueLinkError,
  type IssueLinkedThread,
  type IssueTarget,
  type ThreadId,
  type ThreadIssueLink,
  type ThreadsForIssuesInput,
  type ThreadsForIssuesResult,
  gitHubRepositoryOf,
  issueKeyString,
  issueKeysEqual,
  issueNumberFromBranch,
  issueUrlFor,
  parseIssueUrl,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ClosingReferences from "./closingReferences.ts";
import {
  type DerivedIssueLink,
  type StoredIssueLink,
  type StoredIssueLinkSource,
  combineThreadIssueLinks,
} from "./threadIssueLinks.ts";

export type IssueLinkWriteSource = Exclude<StoredIssueLinkSource, "dismissed">;

/**
 * Thread ↔ GitHub Issue links. Stored links live in the fork-owned `fork_thread_issue_links`
 * table, outside upstream migrations and the event log; branch and closing-reference links are
 * derived on every read. Change subscribers hear each stored change with the thread and Issues it
 * touched; clients already see branch and pull request changes on the thread and reread for those.
 */
export class IssueLinks extends Context.Service<
  IssueLinks,
  {
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadIssueLink>, IssueLinkError>;
    /** Threads for a page of Issues; closing pull requests are the caller's, so no GitHub read. */
    readonly threadsForIssues: (
      input: ThreadsForIssuesInput,
    ) => Effect.Effect<ThreadsForIssuesResult["issues"], IssueLinkError>;
    readonly link: (input: {
      readonly threadId: ThreadId;
      readonly target: IssueTarget;
      readonly source: IssueLinkWriteSource;
    }) => Effect.Effect<
      { readonly link: IssueKey; readonly alreadyLinked: boolean },
      IssueLinkError
    >;
    readonly unlink: (input: {
      readonly threadId: ThreadId;
      readonly issue: IssueKey;
    }) => Effect.Effect<{ readonly wasLinked: boolean }, IssueLinkError>;
    /**
     * Pull requests on `host` linked to threads that link to an Issue there (a stored link, or a
     * task branch naming one), newest link first, each once. The Issues list reads their real
     * state from GitHub, so no last-synced state filters them here.
     */
    readonly pullRequestsOfIssueThreads: (
      host: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly repository: string; readonly number: number }>,
      IssueLinkError
    >;
    /** Resolve an agent's or user's target against the thread's project repository. */
    readonly resolveTarget: (
      threadId: ThreadId,
      target: IssueTarget,
    ) => Effect.Effect<IssueKey & { readonly url: string }, IssueLinkError>;
    /** Subscribes at once, so nothing published after this returns is missed. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<IssueLinkChange>, never, Scope.Scope>;
  }
>()("t3/issueLinks/IssueLinks") {}

interface StoredRow {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly source: StoredIssueLinkSource;
  readonly linkedAt: string;
}

interface ThreadRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

const isIssueLinkError = Schema.is(IssueLinkError);

/** Reports storage and projection failures as one `IssueLinkError`, keeping ones already typed. */
const failWith = (detail: string) =>
  Effect.catch((cause: unknown) =>
    isIssueLinkError(cause)
      ? Effect.fail(cause)
      : Effect.logWarning(detail, cause).pipe(
          Effect.andThen(Effect.fail(new IssueLinkError({ detail }))),
        ),
  );

const PRUNE_INTERVAL_MS = 10 * 60_000;
const STALE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

const normalizeIssueKey = (key: IssueKey): IssueKey => ({
  host: key.host.toLowerCase(),
  repository: key.repository.toLowerCase(),
  number: key.number,
});

function groupBy<A>(items: ReadonlyArray<A>, keyOf: (item: A) => string): Map<string, A[]> {
  const groups = new Map<string, A[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

const storedOf = (row: StoredRow): StoredIssueLink => ({
  key: { host: row.host, repository: row.repository, number: row.number },
  url: row.url,
  source: row.source,
  linkedAt: row.linkedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const closing = yield* ClosingReferences.IssueClosingReferences;
  const pubsub = yield* PubSub.unbounded<IssueLinkChange>();

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_issue_links (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, host, repository, number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_thread_issue_links_issue
    ON fork_thread_issue_links(host, repository, number)
  `;

  const storedForThread = (threadId: ThreadId) =>
    sql<StoredRow>`
      SELECT host, repository, number, url, source, linked_at AS "linkedAt"
      FROM fork_thread_issue_links
      WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows.map(storedOf)));

  const projectContext = Effect.fn("IssueLinks.projectContext")(function* (threadId: ThreadId) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return null;
    const project = Option.getOrNull(yield* snapshots.getProjectShellById(thread.value.projectId));
    return {
      thread: thread.value,
      project,
      repository: gitHubRepositoryOf(project?.repositoryIdentity),
    };
  });

  const forThread = Effect.fn("IssueLinks.forThread")(function* (threadId: ThreadId) {
    const context = yield* projectContext(threadId);
    if (context === null) {
      return yield* new IssueLinkError({ detail: `Thread ${threadId} was not found.` });
    }
    const stored = yield* storedForThread(threadId);
    const derived: DerivedIssueLink[] = [];
    const { repository, project, thread } = context;
    const branchIssue = issueNumberFromBranch(thread.branch);
    if (repository !== null && branchIssue !== null) {
      derived.push({ key: { ...repository, number: branchIssue }, source: "branch" });
    }
    if (repository !== null && project !== null) {
      const pullRequests = visibleThreadPullRequests(thread.pullRequests).filter(
        (link) => link.host.toLowerCase() === repository.host,
      );
      const closed = yield* Effect.forEach(
        pullRequests,
        (link) =>
          closing.issuesClosedBy({
            pullRequest: link,
            version: link.snapshot?.updatedAt ?? null,
            cwd: project.workspaceRoot,
          }),
        { concurrency: 4 },
      );
      for (const key of closed.flat()) derived.push({ key, source: "closing-reference" });
    }
    return combineThreadIssueLinks(stored, derived);
  }, failWith("Could not read the thread's Issue links."));

  // Pruned on read, at most every ten minutes: rows of threads deleted over a week ago, and of
  // drafts never sent within a week. Recent deletions stay: a first send whose bootstrap fails
  // deletes its thread, and the retry creates the same id again.
  const lastPruneAt = yield* Ref.make(0);
  const pruneIfDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = yield* Ref.modify(lastPruneAt, (last) =>
      now - last >= PRUNE_INTERVAL_MS ? [true, now] : [false, last],
    );
    if (!due) return;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - STALE_LINK_TTL_MS));
    yield* sql`
      DELETE FROM fork_thread_issue_links
      WHERE thread_id IN (
          SELECT thread_id FROM projection_threads
          WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
        )
        OR (linked_at < ${cutoff}
          AND thread_id NOT IN (SELECT thread_id FROM projection_threads))
    `;
  });

  const threadsForIssues = Effect.fn("IssueLinks.threadsForIssues")(function* (
    input: ThreadsForIssuesInput,
  ) {
    yield* pruneIfDue;
    const issues = input.issues.map((issue) => ({
      key: normalizeIssueKey(issue),
      closingPullRequests: issue.closingPullRequests.map((pullRequest) => ({
        repository: pullRequest.repository.toLowerCase(),
        number: pullRequest.number,
      })),
    }));
    type Linked = { row: ThreadRow; stored: StoredIssueLink[]; derived: DerivedIssueLink[] };
    const byIssue = new Map<string, Map<string, Linked>>(
      issues.map(({ key }) => [issueKeyString(key), new Map()]),
    );
    const entry = (issue: IssueKey, row: ThreadRow) => {
      const threads = byIssue.get(issueKeyString(issue));
      if (threads === undefined) return null;
      const existing = threads.get(row.threadId);
      if (existing !== undefined) return existing;
      const created: Linked = { row, stored: [], derived: [] };
      threads.set(row.threadId, created);
      return created;
    };

    const repositories = groupBy(issues, ({ key }) => `${key.host}\0${key.repository}`);
    for (const group of repositories.values()) {
      const { host, repository } = group[0]!.key;
      const numbers = group.map(({ key }) => key.number);
      const storedRows = yield* sql<StoredRow & ThreadRow>`
        SELECT link.thread_id AS "threadId", link.host, link.repository, link.number, link.url,
          link.source, link.linked_at AS "linkedAt", t.project_id AS "projectId", t.title,
          t.archived_at AS "archivedAt", t.updated_at AS "updatedAt"
        FROM fork_thread_issue_links AS link
        JOIN projection_threads AS t ON t.thread_id = link.thread_id
        WHERE link.host = ${host} AND link.repository = ${repository}
          AND ${sql.in("link.number", numbers)} AND t.deleted_at IS NULL
      `;
      for (const row of storedRows) {
        entry({ host, repository, number: row.number }, row)?.stored.push(storedOf(row));
      }
    }

    const projects = (yield* snapshots.getProjectShells()).flatMap((project) => {
      const repository = gitHubRepositoryOf(project.repositoryIdentity);
      return repository !== null && repositories.has(`${repository.host}\0${repository.repository}`)
        ? [{ id: project.id, ...repository }]
        : [];
    });
    for (const project of projects) {
      const rows = yield* sql<ThreadRow & { readonly branch: string }>`
        SELECT thread_id AS "threadId", project_id AS "projectId", title,
          archived_at AS "archivedAt", updated_at AS "updatedAt", branch
        FROM projection_threads
        WHERE project_id = ${project.id} AND deleted_at IS NULL AND branch IS NOT NULL
      `;
      for (const row of rows) {
        const number = issueNumberFromBranch(row.branch);
        if (number === null) continue;
        const key = { host: project.host, repository: project.repository, number };
        entry(key, row)?.derived.push({ key, source: "branch" });
      }
    }

    const closing = issues.flatMap(({ key, closingPullRequests }) =>
      closingPullRequests.map((pullRequest) => ({ issue: key, host: key.host, ...pullRequest })),
    );
    const pullRequestGroups = groupBy(closing, (pr) => `${pr.host}\0${pr.repository}`);
    for (const group of pullRequestGroups.values()) {
      const { host, repository } = group[0]!;
      const rows = yield* sql<ThreadRow & { readonly number: number }>`
        SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title,
          t.archived_at AS "archivedAt", t.updated_at AS "updatedAt", link.number
        FROM projection_thread_pull_requests AS link
        JOIN projection_threads AS t ON t.thread_id = link.thread_id
        WHERE link.host = ${host} AND link.repository = ${repository}
          AND ${sql.in(
            "link.number",
            group.map((pr) => pr.number),
          )}
          AND link.source != 'stack-dismissed' AND t.deleted_at IS NULL
      `;
      for (const row of rows) {
        for (const pr of group) {
          if (pr.number !== row.number) continue;
          entry(pr.issue, row)?.derived.push({ key: pr.issue, source: "closing-reference" });
        }
      }
    }

    // Each linked thread's own pull requests: a component PR into a non-default branch makes no
    // closing reference, so the Issue's status reaches it only through the thread.
    const threadIds = [...new Set([...byIssue.values()].flatMap((threads) => [...threads.keys()]))];
    const pullRequestsByThread = new Map<string, Array<IssueKey>>();
    if (threadIds.length > 0) {
      const rows = yield* sql<{ readonly threadId: string } & IssueKey>`
        SELECT thread_id AS "threadId", host, repository, number
        FROM projection_thread_pull_requests
        WHERE ${sql.in("thread_id", threadIds)} AND source != 'stack-dismissed'
      `;
      for (const row of rows) {
        const pullRequests = pullRequestsByThread.get(row.threadId) ?? [];
        pullRequests.push({ host: row.host, repository: row.repository, number: row.number });
        pullRequestsByThread.set(row.threadId, pullRequests);
      }
    }

    return issues.map(({ key }) => ({
      ...key,
      threads: [...(byIssue.get(issueKeyString(key))?.values() ?? [])]
        .toSorted(
          (left, right) =>
            right.row.updatedAt.localeCompare(left.row.updatedAt) ||
            left.row.threadId.localeCompare(right.row.threadId),
        )
        .flatMap(({ row, stored, derived }): IssueLinkedThread[] => {
          const [link] = combineThreadIssueLinks(stored, derived);
          return link === undefined
            ? []
            : [
                {
                  id: row.threadId as IssueLinkedThread["id"],
                  projectId: row.projectId as IssueLinkedThread["projectId"],
                  title: row.title,
                  archivedAt: row.archivedAt,
                  sources: link.sources,
                  pullRequests: pullRequestsByThread.get(row.threadId) ?? [],
                },
              ];
        }),
    }));
  }, failWith("Could not read the Issues' linked threads."));

  const pullRequestsOfIssueThreads = Effect.fn("IssueLinks.pullRequestsOfIssueThreads")(function* (
    host: string,
  ) {
    const rows = yield* sql<{
      readonly repository: string;
      readonly number: number;
      readonly branch: string | null;
      readonly stored: number;
    }>`
      SELECT link.repository, link.number, t.branch,
        EXISTS (
          SELECT 1 FROM fork_thread_issue_links AS issue
          WHERE issue.thread_id = t.thread_id AND issue.host = ${host.toLowerCase()}
            AND issue.source != 'dismissed'
        ) AS stored
      FROM projection_thread_pull_requests AS link
      JOIN projection_threads AS t ON t.thread_id = link.thread_id
      WHERE link.host = ${host.toLowerCase()} AND link.source != 'stack-dismissed'
        AND t.deleted_at IS NULL
      ORDER BY link.linked_at DESC, link.repository, link.number
    `;
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const key = `${row.repository.toLowerCase()}#${row.number}`;
      if (seen.has(key)) return [];
      if (!row.stored && issueNumberFromBranch(row.branch) === null) return [];
      seen.add(key);
      return [{ repository: row.repository, number: row.number }];
    });
  }, failWith("Could not read the pull requests of Issue threads."));

  const resolveTarget = Effect.fn("IssueLinks.resolveTarget")(function* (
    threadId: ThreadId,
    target: IssueTarget,
  ) {
    if (target.url !== undefined) {
      const key = parseIssueUrl(target.url);
      if (key === null) {
        return yield* new IssueLinkError({
          detail: "This is not a GitHub Issue URL. Pass repository and number instead.",
        });
      }
      return { ...key, url: issueUrlFor(key) };
    }
    if (target.number === undefined) {
      return yield* new IssueLinkError({ detail: "Pass either url, or number." });
    }
    const context = yield* projectContext(threadId);
    const repository = target.repository?.toLowerCase() ?? context?.repository?.repository;
    const host = target.host?.toLowerCase() ?? context?.repository?.host ?? "github.com";
    if (repository === undefined || !repository.includes("/")) {
      return yield* new IssueLinkError({
        detail: "This thread's project has no GitHub repository. Pass repository or url.",
      });
    }
    const key = { host, repository, number: target.number };
    return { ...key, url: issueUrlFor(key) };
  }, failWith("Could not read the thread's project."));

  const notify = (threadId: ThreadId, issues: ReadonlyArray<IssueKey>) =>
    PubSub.publish(pubsub, { threadId, issues }).pipe(Effect.asVoid);

  /** The thread's visible links; a thread not created yet (a draft) has only stored ones. */
  const currentLinks = (threadId: ThreadId) =>
    forThread(threadId).pipe(
      Effect.catchTag("IssueLinkError", () =>
        storedForThread(threadId).pipe(Effect.map((stored) => combineThreadIssueLinks(stored, []))),
      ),
    );

  const link = Effect.fn("IssueLinks.link")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: IssueTarget;
    readonly source: IssueLinkWriteSource;
  }) {
    const target = yield* resolveTarget(input.threadId, input.target);
    const { url, ...key } = target;
    const touched: IssueKey[] = [];
    if (input.source === "started") {
      // A draft starts from one Issue. A reused draft drops the Issue it was started from before.
      const previous = yield* sql<StoredRow>`
        DELETE FROM fork_thread_issue_links
        WHERE thread_id = ${input.threadId} AND source = 'started'
          AND NOT (host = ${key.host} AND repository = ${key.repository} AND number = ${key.number})
        RETURNING host, repository, number, url, source, linked_at AS "linkedAt"
      `;
      touched.push(...previous.map((row) => storedOf(row).key));
    }
    const alreadyLinked = (yield* currentLinks(input.threadId)).some((current) =>
      issueKeysEqual(current, key),
    );
    if (!alreadyLinked) {
      const linkedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR REPLACE INTO fork_thread_issue_links
          (thread_id, host, repository, number, url, source, linked_at)
        VALUES (${input.threadId}, ${key.host}, ${key.repository}, ${key.number},
          ${url}, ${input.source}, ${linkedAt})
      `;
      touched.push(key);
    }
    if (touched.length > 0) yield* notify(input.threadId, touched);
    return { link: key, alreadyLinked };
  }, failWith("Could not link the Issue."));

  const unlink = Effect.fn("IssueLinks.unlink")(function* (input: {
    readonly threadId: ThreadId;
    readonly issue: IssueKey;
  }) {
    const issue = normalizeIssueKey(input.issue);
    const wasLinked = (yield* currentLinks(input.threadId)).some((current) =>
      issueKeysEqual(current, issue),
    );
    // Always a tombstone, not a delete, and written even when nothing looked linked: a branch or
    // closing reference (possibly unreadable right now) would otherwise put the link back.
    const linkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT OR REPLACE INTO fork_thread_issue_links
        (thread_id, host, repository, number, url, source, linked_at)
      VALUES (${input.threadId}, ${issue.host}, ${issue.repository}, ${issue.number},
        ${issueUrlFor(issue)}, 'dismissed', ${linkedAt})
    `;
    yield* notify(input.threadId, [issue]);
    return { wasLinked };
  }, failWith("Could not unlink the Issue."));

  return IssueLinks.of({
    forThread,
    threadsForIssues,
    link,
    unlink,
    pullRequestsOfIssueThreads,
    resolveTarget,
    subscribeChanges: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(IssueLinks, make);

export const layerLive = layer.pipe(Layer.provide(ClosingReferences.layer));
