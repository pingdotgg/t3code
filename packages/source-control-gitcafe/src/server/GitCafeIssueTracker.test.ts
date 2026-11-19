import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeIssueTracker from "./GitCafeIssueTracker.ts";

const isApiError = Schema.is(GitCafeApi.GitCafeApiError);
const target = { cwd: "/repo", host: "git.cafe", scope: "acme/web" };
const listInput = {
  ...target,
  involvement: "all" as const,
  state: "open" as const,
  sort: "updated" as const,
  limit: 30,
};

const github = (login: string, actorId: string) => ({
  kind: "github",
  actorId,
  authority: "https://github.com",
  providerId: 1,
  login,
  accountType: "user",
  avatarUrl: `/avatars/v1/${login}`,
  linkedProfile: null,
});
const local = (handle: string, actorId: string) => ({
  kind: "local",
  actorId,
  handle,
  displayName: "Mona Lisa",
  avatarUrl: null,
});

const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
  author: github("octo", "act_octo"),
  id: `issue_${number}`,
  repoId: "repo_1",
  number,
  title: `Issue ${number}`,
  description: "Steps to reproduce.",
  version: 1,
  stateType: "backlog",
  priority: 0,
  authorActorId: "act_octo",
  closedAt: null,
  closedReason: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  labels: [{ id: "label_bug", name: "bug", color: "#d73a4a" }],
  assignees: [
    {
      id: "act_mona",
      actor: local("mona", "act_mona"),
      handle: "mona",
      displayName: "Mona Lisa",
      avatarUrl: null,
    },
  ],
  milestone: null,
  reactionCounts: { items: [], truncated: false },
  ...overrides,
});

const comment = (id: string, createdAt: string) => ({
  author: github("octo", "act_octo"),
  id,
  issueId: "issue_42",
  repoId: "repo_1",
  authorActorId: "act_octo",
  body: `Comment ${id}`,
  version: 0,
  createdAt,
  updatedAt: createdAt,
  hiddenAt: null,
  hiddenReason: null,
  capabilities: { edit: false, delete: false, hide: false, unhide: false },
});

/** Answers by path without its query, and records every request with its query. */
function fakeGitCafe(routes: Record<string, unknown>) {
  const sent: Array<{
    readonly path: string;
    readonly query: URLSearchParams;
    readonly method: string;
  }> = [];
  const layer = Layer.succeed(
    GitCafeApi.GitCafeApi,
    GitCafeApi.GitCafeApi.of({
      request: (input) => {
        const url = new URL(input.path, "https://git.cafe");
        sent.push({ path: url.pathname, query: url.searchParams, method: input.method ?? "GET" });
        const route = routes[url.pathname];
        if (isApiError(route)) return Effect.fail(route);
        if (route === undefined)
          return Effect.fail(
            new GitCafeApi.GitCafeApiError({
              host: input.host,
              operation: input.operation,
              status: 404,
              reason: "not-found",
              detail: "Not found.",
            }),
          );
        return Effect.succeed(
          JSON.stringify(typeof route === "function" ? route(url.searchParams) : route),
        );
      },
    }),
  );
  const tracker = GitCafeIssueTracker.make.pipe(Effect.provide(layer));
  return { tracker, sent };
}

describe("GitCafeIssueTracker", () => {
  it.effect("is read-only and searches through GitCafe", () =>
    Effect.gen(function* () {
      const { tracker } = fakeGitCafe({});
      const api = yield* tracker;
      assert.deepStrictEqual(api.capabilities, {
        create: false,
        edit: false,
        comment: false,
        labels: false,
        assignees: false,
        reactions: false,
        templates: false,
        linkedPullRequests: false,
        events: false,
        search: true,
      });
      for (const write of ["create", "comment", "update", "setState", "setReaction"] as const)
        assert.isUndefined(api[write], write);
    }),
  );

  it.effect("lists a page of issues and carries on from GitCafe's cursor", () =>
    Effect.gen(function* () {
      const { tracker, sent } = fakeGitCafe({
        "/repos/acme/web/issues/": (query: URLSearchParams) =>
          query.get("after") === "page2"
            ? { items: [], next: null, total: 1 }
            : { items: [issue(42)], next: "page2", total: 1 },
      });
      const api = yield* tracker;
      const first = yield* api.listIssues({ ...listInput, query: "focus" });
      assert.deepStrictEqual(first, {
        items: [
          {
            key: "42",
            displayKey: "#42",
            title: "Issue 42",
            url: "https://git.cafe/acme/web/issues/42",
            author: { login: "octo", name: null, avatarUrl: "https://git.cafe/avatars/v1/octo" },
            state: { category: "open", name: "Backlog" },
            createdAt: "2026-11-01T10:00:00.000Z",
            updatedAt: "2026-11-02T10:00:00.000Z",
            closedAt: null,
            assignees: [{ login: "mona", name: "Mona Lisa", avatarUrl: null }],
            labels: [{ name: "bug", color: "#d73a4a" }],
            commentCount: 0,
          },
        ],
        nextCursor: "page2",
      });
      assert.deepStrictEqual(Object.fromEntries(sent[0]!.query), {
        limit: "30",
        sort: "updated",
        direction: "desc",
        statuses: "open",
        q: "focus",
      });

      const second = yield* api.listIssues({ ...listInput, state: "all", cursor: "page2" });
      assert.deepStrictEqual(second, { items: [], nextCursor: null });
      assert.isNull(sent[1]!.query.get("statuses"));
      assert.strictEqual(sent[1]!.query.get("after"), "page2");

      const refused = yield* api
        .listIssues({ ...listInput, cursor: "not a cursor" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "failed");
      assert.strictEqual(sent.length, 2);
    }),
  );

  it.effect("narrows by the viewer, labels and assignee as GitCafe filters them", () =>
    Effect.gen(function* () {
      const { tracker, sent } = fakeGitCafe({
        "/auth/principal": { actorId: "act_viewer", handle: "viewer" },
        "/repos/acme/web/labels": {
          items: [
            { id: "label_bug", name: "bug", color: null },
            { id: "label_ui", name: "UI", color: null },
          ],
          next: null,
        },
        "/repos/acme/web/issues/": (query: URLSearchParams) =>
          query.get("after") === "octo-page"
            ? {
                items: [
                  issue(3, {
                    assignees: [
                      {
                        id: "act_octo",
                        actor: github("Octo", "act_octo"),
                        handle: "Octo",
                        displayName: null,
                        avatarUrl: null,
                      },
                    ],
                  }),
                ],
                next: null,
              }
            : {
                items: [
                  issue(1, {
                    labels: [
                      { id: "label_bug", name: "bug", color: "#d73a4a" },
                      { id: "label_ui", name: "UI", color: "#000000" },
                    ],
                  }),
                  issue(2),
                ],
                next: "octo-page",
                total: 3,
              },
      });
      const api = yield* tracker;
      const issuesQuery = () => Object.fromEntries(sent.at(-1)!.query);

      yield* api.listIssues({ ...listInput, involvement: "authored", viewer: "viewer" });
      assert.strictEqual(issuesQuery().author, "act_viewer");

      const mine = yield* api.listIssues({
        ...listInput,
        involvement: "assigned",
        viewer: "viewer",
        assignee: "MONA",
      });
      assert.strictEqual(issuesQuery().assignee, "act_viewer");
      assert.deepStrictEqual(
        mine.items.map((item) => item.key),
        ["1", "2"],
      );

      // GitCafe matches any of several labels, so it narrows by one and every one is kept here.
      const labelled = yield* api.listIssues({ ...listInput, labels: ["bug", "ui"] });
      assert.strictEqual(issuesQuery().labels, "label_bug");
      assert.deepStrictEqual(
        labelled.items.map((item) => item.key),
        ["1"],
      );

      // An assignee is matched by the login an issue shows, whatever its case, so a page
      // without one comes back empty and still carries on to the page that has one.
      const first = yield* api.listIssues({ ...listInput, assignee: "OCTO" });
      assert.deepStrictEqual(first, { items: [], nextCursor: "octo-page" });
      assert.isNull(sent.at(-1)!.query.get("assignees"));
      const second = yield* api.listIssues({
        ...listInput,
        assignee: "OCTO",
        cursor: first.nextCursor!,
      });
      assert.deepStrictEqual(
        second.items.map((item) => [item.key, item.assignees[0]!.login]),
        [["3", "Octo"]],
      );
      assert.isNull(second.nextCursor);

      const before = sent.length;
      assert.deepStrictEqual(yield* api.listIssues({ ...listInput, labels: ["missing"] }), {
        items: [],
        nextCursor: null,
      });
      assert.deepStrictEqual(
        yield* api.listIssues({ ...listInput, involvement: "mentioned", viewer: "viewer" }),
        { items: [], nextCursor: null },
      );
      assert.isFalse(
        sent.slice(before).some((request) => request.path === "/repos/acme/web/issues/"),
      );
      assert.isTrue(sent.every((request) => request.method === "GET"));
      assert.isFalse(
        sent.some(
          (request) =>
            request.path.startsWith("/users/") || request.path.endsWith("filter-options"),
        ),
      );
    }),
  );

  it.effect("reads an issue with its newest comments and pages back to older ones", () =>
    Effect.gen(function* () {
      // GitCafe hands comments out oldest first and only pages forward.
      const pages: Record<string, { items: Array<unknown>; next: string | null }> = {
        "": { items: [comment("c1", "2026-11-02T10:00:00.000Z")], next: "p2" },
        p2: { items: [comment("c2", "2026-11-02T11:00:00.000Z")], next: "p3" },
        p3: { items: [comment("c3", "2026-11-02T12:00:00.000Z")], next: "p4" },
        // A trailing page with nothing on it leaves the page before it as the newest.
        p4: { items: [], next: null },
      };
      const { tracker, sent } = fakeGitCafe({
        "/repos/acme/web/issues/42": issue(42, {
          stateType: "canceled",
          closedAt: "2026-11-03T10:00:00.000Z",
          description: null,
        }),
        "/repos/acme/web/issues/42/comments/": (query: URLSearchParams) =>
          pages[query.get("after") ?? ""],
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "42" });
      assert.deepStrictEqual(detail.state, {
        category: "closed",
        name: "Canceled",
        closeReason: "canceled",
      });
      assert.strictEqual(detail.closedAt, "2026-11-03T10:00:00.000Z");
      assert.strictEqual(detail.body, "");
      assert.isNull(detail.viewer);
      assert.deepStrictEqual(detail.states, []);
      assert.deepStrictEqual(detail.viewerPermissions, {
        setState: false,
        comment: false,
        edit: false,
        labels: false,
        assignees: false,
      });
      assert.deepStrictEqual(detail.comments, [
        {
          id: "c3",
          author: { login: "octo", name: null, avatarUrl: "https://git.cafe/avatars/v1/octo" },
          body: "Comment c3",
          createdAt: "2026-11-02T12:00:00.000Z",
          url: null,
        },
      ]);
      assert.strictEqual(detail.commentCount, 3);
      assert.deepStrictEqual(detail.events, []);
      assert.deepStrictEqual(detail.linkedPullRequests, []);

      const seen = [detail.comments.map((item) => item.id)];
      let cursor = detail.commentsCursor;
      const reads = sent.length;
      while (cursor !== null) {
        const older = yield* api.getComments({ ...target, key: "42", cursor });
        seen.push(older.comments.map((item) => item.id));
        cursor = older.nextCursor;
      }
      assert.deepStrictEqual(seen, [["c3"], ["c2"], ["c1"]]);
      // Each older page is one read from where that page starts.
      assert.deepStrictEqual(
        sent.slice(reads).map((request) => request.query.get("after")),
        ["p2", null],
      );

      for (const forged of ["p2", "o.not a cursor", "o..p2"]) {
        const refused = yield* api
          .getComments({ ...target, key: "42", cursor: forged })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "failed", forged);
      }
      assert.strictEqual(sent.length, reads + 2);

      const missing = yield* api.getIssue({ ...target, key: "ENG-1" }).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "not-found");
    }),
  );

  it.effect("keeps one page of comments whole and reads the issue past a walk it gives up on", () =>
    Effect.gen(function* () {
      const refused = new GitCafeApi.GitCafeApiError({
        host: "git.cafe",
        operation: "getIssue",
        status: 403,
        reason: "failed",
        detail: "You cannot read comments on this issue.",
      });
      const { tracker, sent } = fakeGitCafe({
        "/repos/acme/web/issues/3": issue(3),
        "/repos/acme/web/issues/3/comments/": (query: URLSearchParams) => ({
          items: [comment(`c-${query.get("after")}`, "2026-11-02T10:00:00.000Z")],
          next: `p${Number(query.get("after")?.slice(1) ?? 1) + 1}`,
        }),
        "/repos/acme/web/issues/1": issue(1),
        "/repos/acme/web/issues/1/comments/": {
          items: [comment("c1", "2026-11-02T10:00:00.000Z")],
          next: null,
        },
        "/repos/acme/web/issues/2": issue(2),
        "/repos/acme/web/issues/2/comments/": (query: URLSearchParams) => ({
          items: [comment(`c-${query.get("after")}`, "2026-11-02T10:00:00.000Z")],
          next: query.get("after") === "b" ? "a" : query.get("after") === "a" ? "b" : "a",
        }),
        "/repos/acme/web/issues/4": issue(4),
        "/repos/acme/web/issues/4/comments/": refused,
        "/repos/acme/web/issues/5": issue(5),
        "/repos/acme/web/issues/5/comments/": { items: [{ id: "c1" }], next: null },
      });
      const api = yield* tracker;
      const single = yield* api.getIssue({ ...target, key: "1" });
      assert.deepStrictEqual(
        single.comments.map((item) => item.id),
        ["c1"],
      );
      assert.isNull(single.commentsCursor);
      assert.isUndefined(single.commentsUnavailable);

      const unavailable = (detail: typeof single) => ({
        title: detail.title,
        body: detail.body,
        state: detail.state.name,
        comments: detail.comments,
        commentCount: detail.commentCount,
        commentsCursor: detail.commentsCursor,
        commentsUnavailable: detail.commentsUnavailable,
      });
      const expected = (number: number) => ({
        title: `Issue ${number}`,
        body: "Steps to reproduce.",
        state: "Backlog",
        comments: [],
        commentCount: 0,
        commentsCursor: null,
        commentsUnavailable: true,
      });

      // Refused, unreadable, looping and endless conversations each keep the issue readable.
      assert.deepStrictEqual(
        unavailable(yield* api.getIssue({ ...target, key: "4" })),
        expected(4),
      );
      assert.deepStrictEqual(
        unavailable(yield* api.getIssue({ ...target, key: "5" })),
        expected(5),
      );
      assert.deepStrictEqual(
        unavailable(yield* api.getIssue({ ...target, key: "2" })),
        expected(2),
      );
      const before = sent.length;
      assert.deepStrictEqual(
        unavailable(yield* api.getIssue({ ...target, key: "3" })),
        expected(3),
      );
      assert.strictEqual(
        sent.slice(before).filter((request) => request.path.endsWith("/comments/")).length,
        30,
      );
    }),
  );

  it.effect("fails when the issue itself cannot be read, whatever its comments do", () =>
    Effect.gen(function* () {
      const { tracker } = fakeGitCafe({
        "/repos/acme/web/issues/6/comments/": { items: [], next: null },
        "/repos/acme/web/issues/7": new GitCafeApi.GitCafeApiError({
          host: "git.cafe",
          operation: "getIssue",
          status: 401,
          reason: "unauthenticated",
          detail: "Sign in to GitCafe.",
        }),
        "/repos/acme/web/issues/8": { number: 8 },
        "/repos/acme/web/issues/8/comments/": { items: [], next: null },
      });
      const api = yield* tracker;
      const missing = yield* api.getIssue({ ...target, key: "6" }).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "not-found");
      const signedOut = yield* api.getIssue({ ...target, key: "7" }).pipe(Effect.flip);
      assert.strictEqual(signedOut.reason, "unauthenticated");
      const unreadable = yield* api.getIssue({ ...target, key: "8" }).pipe(Effect.flip);
      assert.strictEqual(unreadable.reason, "failed");
    }),
  );

  it.effect("reports GitCafe's failure reason so a signed-out host is disabled", () =>
    Effect.gen(function* () {
      const { tracker } = fakeGitCafe({
        "/auth/principal": new GitCafeApi.GitCafeApiError({
          host: "git.cafe",
          operation: "getViewer",
          status: null,
          reason: "unauthenticated",
          detail: "Sign in to GitCafe.",
        }),
      });
      const api = yield* tracker;
      const error = yield* api.getViewer(target).pipe(Effect.flip);
      assert.strictEqual(error.reason, "unauthenticated");
      assert.strictEqual(error.tracker, "gitcafe");
    }),
  );
});
