import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { IssuesToolkitHandlersLive } from "../mcp/toolkits/issues/handlers.ts";
import { IssuesToolkit } from "../mcp/toolkits/issues/tools.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { IssueLinks, layer as issueLinksLayer } from "./IssueLinks.ts";
import {
  closingReferencesLive,
  insertProject,
  insertPullRequestLink,
  insertThread,
  projectionLayer,
} from "./IssueLinks.testFixtures.ts";
import { combineThreadIssueLinks } from "./threadIssueLinks.ts";

// These threads link no pull requests, so nothing here reads GitHub; closing references are
// covered against real GitHub in `IssueLinks.live.test.ts`.
const REPOSITORIES = { "/work/acme-web": "acme/web", "/work/acme-api": "acme/api" };
const THREAD = ThreadId.make("thread-web");

const servicesOver = <E, R>(persistence: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  issueLinksLayer.pipe(
    Layer.provideMerge(projectionLayer(REPOSITORIES)),
    Layer.provide(closingReferencesLive),
    Layer.provideMerge(persistence),
  );
const services = servicesOver(SqlitePersistenceMemory);

const seed = Effect.gen(function* () {
  yield* insertProject("project-web", "/work/acme-web");
  yield* insertProject("project-api", "/work/acme-api");
  yield* insertThread({ id: THREAD, projectId: "project-web", branch: "feat/28-issue-links" });
  yield* insertThread({
    id: "thread-web-older",
    projectId: "project-web",
    branch: "fix/280-other-issue",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  yield* insertThread({ id: "thread-plain", projectId: "project-web", branch: "release/2026-09" });
  yield* insertThread({ id: "thread-api", projectId: "project-api", branch: "feat/28-api-side" });
  yield* insertThread({
    id: "thread-deleted",
    projectId: "project-web",
    branch: "feat/28-gone",
    deletedAt: "2026-09-02T00:00:00.000Z",
  });
});

const issue = (number: number, repository = "acme/web") => ({
  host: "github.com",
  repository,
  number,
});

const linksOf = (links: ReadonlyArray<ThreadIssueLink>) =>
  links.map((link) => ({ issue: `${link.repository}#${link.number}`, sources: link.sources }));

/** Thread ids and sources per Issue, for Issues with no closing pull requests. */
const threadsFor = (...issues: ReadonlyArray<ReturnType<typeof issue>>) =>
  Effect.flatMap(IssueLinks, (links) =>
    links.threadsForIssues({
      issues: issues.map((key) => ({ ...key, closingPullRequests: [] })),
    }),
  ).pipe(
    Effect.map((results) =>
      results.map((result) => result.threads.map((thread) => [thread.id, thread.sources])),
    ),
  );

const storedRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ readonly threadId: string; readonly number: number; readonly source: string }>`
    SELECT thread_id AS "threadId", number, source FROM fork_thread_issue_links
    ORDER BY thread_id, number
  `,
);

describe("IssueLinks", () => {
  it.effect("links manually by number in the thread's repository, once", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      const first = yield* links.link({
        threadId: THREAD,
        target: { number: 12 },
        source: "manual",
      });
      expect(first).toEqual({ link: issue(12), alreadyLinked: false });
      const again = yield* links.link({
        threadId: THREAD,
        target: { url: "https://github.com/Acme/Web/issues/12" },
        source: "manual",
      });
      expect(again.alreadyLinked).toBe(true);

      const forThread = yield* links.forThread(THREAD);
      expect(linksOf(forThread)).toEqual([
        { issue: "acme/web#12", sources: ["manual"] },
        { issue: "acme/web#28", sources: ["branch"] },
      ]);
      expect(forThread[0]).toMatchObject({ url: "https://github.com/acme/web/issues/12" });
      expect(forThread[0]?.linkedAt).not.toBeNull();
      expect(yield* threadsFor(issue(12))).toEqual([[[THREAD, ["manual"]]]]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("derives branch links only from task branches in the project's repository", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      // One batched read for several Issues keeps the caller's order; unknown Issues are empty.
      expect(
        yield* threadsFor(issue(28), issue(28, "acme/api"), issue(280), issue(2026), issue(9)),
      ).toEqual([
        [[THREAD, ["branch"]]],
        [["thread-api", ["branch"]]],
        [["thread-web-older", ["branch"]]],
        [],
        [],
      ]);
      expect(linksOf(yield* links.forThread(ThreadId.make("thread-api")))).toEqual([
        { issue: "acme/api#28", sources: ["branch"] },
      ]);
      expect(yield* links.forThread(ThreadId.make("thread-plain"))).toEqual([]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("reports an Issue its branch already links as linked, without storing it", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      expect(
        yield* links.link({ threadId: THREAD, target: { number: 28 }, source: "manual" }),
      ).toEqual({ link: issue(28), alreadyLinked: true });
      expect(yield* storedRows).toEqual([]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("keeps a removed derived link removed until it is linked again", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      expect(yield* links.unlink({ threadId: THREAD, issue: issue(28) })).toEqual({
        wasLinked: true,
      });
      expect(yield* links.forThread(THREAD)).toEqual([]);
      expect(yield* threadsFor(issue(28))).toEqual([[]]);

      yield* links.link({ threadId: THREAD, target: { number: 28 }, source: "manual" });
      expect(linksOf(yield* links.forThread(THREAD))).toEqual([
        { issue: "acme/web#28", sources: ["manual", "branch"] },
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("records an explicit unlink even when nothing looked linked", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      const plain = ThreadId.make("thread-plain");
      expect(yield* links.unlink({ threadId: plain, issue: issue(50) })).toEqual({
        wasLinked: false,
      });
      // The branch later names #50; the explicit unlink still holds.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET branch = 'feat/50-later' WHERE thread_id = ${plain}`;
      expect(yield* links.forThread(plain)).toEqual([]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("unlinks a stored link and leaves other threads alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      yield* links.link({ threadId: THREAD, target: { number: 7 }, source: "manual" });
      yield* links.link({
        threadId: ThreadId.make("thread-web-older"),
        target: { number: 7 },
        source: "manual",
      });
      yield* links.unlink({ threadId: THREAD, issue: issue(7) });
      expect(yield* threadsFor(issue(7))).toEqual([[["thread-web-older", ["manual"]]]]);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "links a draft started from an Issue, and moves the link when the draft is reused",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const links = yield* IssueLinks;
        const draft = ThreadId.make("thread-draft");
        const start = (number: number) =>
          links.link({
            threadId: draft,
            target: { url: `https://github.com/acme/web/issues/${number}` },
            source: "started",
          });
        yield* start(99);
        // Invisible until the draft's first send creates the thread.
        expect(yield* threadsFor(issue(99))).toEqual([[]]);
        // The empty draft is reused for another Issue.
        yield* start(98);
        yield* insertThread({ id: draft, projectId: "project-web" });
        expect(yield* threadsFor(issue(99), issue(98))).toEqual([[], [[draft, ["started"]]]]);
      }).pipe(Effect.provide(services)),
  );

  it.effect("prunes only week-old deletions and drafts never sent within a week", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-01T00:00:00.000Z"));
      yield* seed;
      const links = yield* IssueLinks;
      const sql = yield* SqlClient.SqlClient;
      const linkTo = (threadId: string, number: number, source: "manual" | "started") =>
        links.link({
          threadId: ThreadId.make(threadId),
          target: { number, repository: "acme/web" },
          source,
        });
      for (const id of ["thread-doomed", "thread-retried", "thread-just-deleted"]) {
        yield* insertThread({ id, projectId: "project-web" });
      }
      yield* linkTo("thread-doomed", 1, "manual");
      yield* linkTo("thread-abandoned-draft", 2, "started");
      yield* linkTo("thread-retried", 4, "started");
      yield* linkTo("thread-web-older", 5, "manual");
      yield* linkTo("thread-just-deleted", 6, "started");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-01T12:00:00.000Z' WHERE thread_id = 'thread-doomed'`;
      // A failed first-send bootstrap deletes the thread; the retry creates the same id again.
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-01T12:00:00.000Z' WHERE thread_id = 'thread-retried'`;
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'thread-retried'`;

      yield* TestClock.adjust("8 days");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-08T12:00:00.000Z' WHERE thread_id = 'thread-just-deleted'`;
      yield* linkTo("thread-pending-draft", 3, "started");
      yield* threadsFor(issue(1));
      expect(yield* storedRows).toEqual([
        { threadId: "thread-just-deleted", number: 6, source: "started" },
        { threadId: "thread-pending-draft", number: 3, source: "started" },
        { threadId: "thread-retried", number: 4, source: "started" },
        { threadId: "thread-web-older", number: 5, source: "manual" },
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("links Issues to threads whose pull requests close them, from caller data", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      yield* insertThread({ id: "thread-closer", projectId: "project-web" });
      yield* insertThread({ id: "thread-dismissed-pr", projectId: "project-web" });
      yield* insertThread({ id: "thread-unlinked", projectId: "project-web" });
      yield* insertThread({ id: "thread-cross", projectId: "project-api" });
      yield* insertPullRequestLink({
        threadId: "thread-closer",
        repository: "acme/web",
        number: 30,
      });
      yield* insertPullRequestLink({
        threadId: "thread-dismissed-pr",
        repository: "acme/web",
        number: 30,
        source: "stack-dismissed",
      });
      yield* insertPullRequestLink({
        threadId: "thread-unlinked",
        repository: "acme/web",
        number: 31,
      });
      yield* insertPullRequestLink({ threadId: "thread-cross", repository: "acme/api", number: 5 });
      yield* links.unlink({ threadId: ThreadId.make("thread-unlinked"), issue: issue(11) });

      const result = yield* links.threadsForIssues({
        issues: [
          {
            host: "GitHub.com",
            repository: "ACME/Web",
            number: 11,
            closingPullRequests: [
              { repository: "Acme/Web", number: 30 },
              { repository: "acme/web", number: 31 },
              // A pull request in another repository closes this Issue too.
              { repository: "Acme/API", number: 5 },
            ],
          },
        ],
      });
      expect(result).toMatchObject([{ host: "github.com", repository: "acme/web", number: 11 }]);
      expect(result[0]!.threads.map((thread) => [thread.id, thread.sources]).toSorted()).toEqual([
        ["thread-closer", ["closing-reference"]],
        ["thread-cross", ["closing-reference"]],
      ]);
      // Each thread carries its own pull requests (#29 counts them toward the Issue's status).
      expect(
        result[0]!.threads.map((thread) => [thread.id, thread.pullRequests]).toSorted(),
      ).toEqual([
        ["thread-closer", [{ host: "github.com", repository: "acme/web", number: 30 }]],
        ["thread-cross", [{ host: "github.com", repository: "acme/api", number: 5 }]],
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "reads the pull requests of threads that link to an Issue, whatever their last state",
    () =>
      Effect.gen(function* () {
        const links = yield* IssueLinks;
        const sql = yield* SqlClient.SqlClient;
        yield* insertProject("project-web", "/work/acme-web");
        const thread = (
          id: string,
          branch: string | null = null,
          deletedAt: string | null = null,
        ) => insertThread({ id, projectId: "project-web", branch, deletedAt });
        const pr = (threadId: string, number: number, source?: "stack-dismissed") =>
          insertPullRequestLink({
            threadId,
            repository: "acme/web",
            number,
            ...(source ? { source } : {}),
          });
        const linkTo = (threadId: string, url: string) =>
          links.link({ threadId: ThreadId.make(threadId), target: { url }, source: "manual" });

        yield* thread("stored");
        yield* linkTo("stored", "https://github.com/acme/web/issues/1");
        yield* pr("stored", 1);
        // Last synced as merged: GitHub's answer in the list's own read decides, not this snapshot.
        yield* pr("stored", 8);
        yield* sql`
        UPDATE projection_thread_pull_requests SET snapshot_json = '{"state":"merged"}'
        WHERE number = 8
      `;
        yield* pr("stored", 6, "stack-dismissed");
        // Component threads usually link only through their task branch.
        yield* thread("task-branch", "feat/29-issue-status");
        yield* pr("task-branch", 2);
        yield* thread("plain-branch", "release/2026-09");
        yield* pr("plain-branch", 3);
        // The same pull request through an unlinked thread still counts once, via the linked one.
        yield* pr("plain-branch", 1);
        yield* thread("dismissed");
        yield* linkTo("dismissed", "https://github.com/acme/web/issues/4");
        yield* links.unlink({ threadId: ThreadId.make("dismissed"), issue: issue(4) });
        yield* pr("dismissed", 4);
        yield* thread("deleted", "feat/5-gone", "2026-09-02T00:00:00.000Z");
        yield* pr("deleted", 5);
        yield* thread("other-host");
        yield* linkTo("other-host", "https://ghe.example.com/acme/web/issues/7");
        yield* pr("other-host", 7);

        const read = yield* links.pullRequestsOfIssueThreads("GitHub.com");
        expect(read.map((candidate) => candidate.number).toSorted()).toEqual([1, 2, 8]);
        expect(yield* links.pullRequestsOfIssueThreads("ghe.example.com")).toEqual([]);
      }).pipe(Effect.provide(services)),
  );

  it.effect("refuses targets it cannot place", () =>
    Effect.gen(function* () {
      yield* seed;
      const links = yield* IssueLinks;
      const pullRequestUrl = yield* links
        .link({
          threadId: THREAD,
          target: { url: "https://github.com/acme/web/pull/3" },
          source: "manual",
        })
        .pipe(Effect.flip);
      expect(pullRequestUrl).toMatchObject({ _tag: "IssueLinkError" });
      const noProject = yield* links
        .link({ threadId: ThreadId.make("missing"), target: { number: 3 }, source: "manual" })
        .pipe(Effect.flip);
      expect(noProject.detail).toContain("no GitHub repository");
    }).pipe(Effect.provide(services)),
  );

  it.effect("tells subscribers which thread and Issues changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const links = yield* IssueLinks;
        const changes = yield* links.subscribeChanges;
        yield* links.link({ threadId: THREAD, target: { number: 5 }, source: "manual" });
        yield* links.unlink({ threadId: THREAD, issue: issue(5) });
        expect(yield* changes.pipe(Stream.take(2), Stream.runCollect)).toEqual([
          { threadId: THREAD, issues: [issue(5)] },
          { threadId: THREAD, issues: [issue(5)] },
        ]);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.effect("keeps stored links across a server restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "state.sqlite");
      const persistence = makeSqlitePersistenceLive(dbPath);

      yield* Effect.gen(function* () {
        yield* seed;
        const links = yield* IssueLinks;
        yield* links.link({ threadId: THREAD, target: { number: 12 }, source: "manual" });
        yield* links.unlink({ threadId: THREAD, issue: issue(28) });
      }).pipe(Effect.provide(servicesOver(persistence)));

      const afterRestart = yield* IssueLinks.pipe(
        Effect.flatMap((links) => links.forThread(THREAD)),
        Effect.provide(servicesOver(persistence)),
      );
      expect(linksOf(afterRestart)).toEqual([{ issue: "acme/web#12", sources: ["manual"] }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("issue MCP tools", () => {
  const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: THREAD,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  });

  const call = <Name extends keyof typeof IssuesToolkit.tools>(
    name: Name,
    params: Tool.Parameters<(typeof IssuesToolkit.tools)[Name]>,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    IssuesToolkit.pipe(
      Effect.flatMap((toolkit) => toolkit.handle(name, params as never)),
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof IssuesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(IssuesToolkitHandlersLive),
    );

  it.effect("links, lists and unlinks for the calling thread with source agent", () =>
    Effect.gen(function* () {
      yield* seed;
      expect(yield* call("link_issue", { number: 41 })).toEqual({
        ...issue(41),
        alreadyLinked: false,
      });
      expect(yield* call("link_issue", { url: "https://github.com/acme/web/issues/41" })).toEqual({
        ...issue(41),
        alreadyLinked: true,
      });
      const listed = yield* call("list_thread_issues", {});
      expect(linksOf(listed.issues)).toEqual([
        { issue: "acme/web#41", sources: ["agent"] },
        { issue: "acme/web#28", sources: ["branch"] },
      ]);
      expect(yield* call("unlink_issue", { number: 41 })).toEqual({
        ...issue(41),
        wasLinked: true,
      });
      const links = yield* IssueLinks;
      expect(linksOf(yield* links.forThread(THREAD))).toEqual([
        { issue: "acme/web#28", sources: ["branch"] },
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      yield* seed;
      const error = yield* call("link_issue", { number: 1 }, ["preview"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
      });
    }).pipe(Effect.provide(services)),
  );
});

describe("combineThreadIssueLinks", () => {
  const key = (number: number) => issue(number);
  it("merges sources, keeps stored order first and drops dismissed Issues", () => {
    expect(
      combineThreadIssueLinks(
        [
          {
            key: key(3),
            url: "https://github.com/acme/web/issues/3",
            source: "agent",
            linkedAt: "2026-09-02T00:00:00.000Z",
          },
          {
            key: key(2),
            url: "https://github.com/acme/web/issues/2",
            source: "manual",
            linkedAt: "2026-09-01T00:00:00.000Z",
          },
          {
            key: key(9),
            url: "https://github.com/acme/web/issues/9",
            source: "dismissed",
            linkedAt: "2026-09-03T00:00:00.000Z",
          },
        ],
        [
          { key: key(3), source: "branch" },
          { key: { host: "GitHub.com", repository: "Acme/Web", number: 4 }, source: "branch" },
          { key: key(9), source: "branch" },
        ],
      ).map((link) => [link.number, link.sources, link.url]),
    ).toEqual([
      [2, ["manual"], "https://github.com/acme/web/issues/2"],
      [3, ["agent", "branch"], "https://github.com/acme/web/issues/3"],
      [4, ["branch"], "https://github.com/acme/web/issues/4"],
    ]);
  });
});
