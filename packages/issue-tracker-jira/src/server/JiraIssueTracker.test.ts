import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const packed = JSON.stringify({
  site: "https://example.atlassian.net/",
  email: "ada@example.test",
  token: "fake-token",
});
const target = { cwd: "/tmp", host: "example.atlassian.net", scope: "ENG", key: "ENG-1" };
const user = { accountId: "native-account", displayName: "Ada" };
const issue = {
  id: "1",
  key: "ENG-1",
  fields: {
    project: { id: "20", key: "ENG" },
    summary: "Task",
    created: "2026-10-14T10:00:00Z",
    updated: "2026-10-14T11:00:00Z",
    creator: user,
    assignee: user,
    labels: ["bug"],
    comment: { total: 4 },
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }],
    },
    status: { id: "2", name: "Review", statusCategory: { key: "indeterminate" } },
  },
};
type Reply = {
  readonly body?: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly pending?: boolean;
};

function fakeJira(
  reply: (request: HttpClientRequest.HttpClientRequest) => Reply,
  initial: string | null = packed,
) {
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  let stored = initial;
  const host = IssueTrackerHost.of({
    credentials: {
      get: () => Effect.sync(() => (stored === null ? Option.none() : Option.some(stored))),
    },
  });
  const http = HttpClient.make((request) => {
    calls.push(request);
    const response = reply(request);
    if (response.pending) return Effect.never;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          response.status === 204 || response.body === undefined
            ? null
            : JSON.stringify(response.body),
          {
            status: response.status ?? 200,
            ...(response.headers === undefined ? {} : { headers: response.headers }),
          },
        ),
      ),
    );
  });
  const transport = JiraApi.make.pipe(
    Effect.provideService(IssueTrackerHost, host),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide(SourceControlRateLimit.layer),
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  return {
    api: JiraIssueTracker.make.pipe(Effect.provideServiceEffect(JiraApi.JiraApi, transport)),
    calls,
    store: (next: string | null) => {
      stored = next;
    },
  };
}

function body(request: HttpClientRequest.HttpClientRequest | undefined): unknown {
  if (request?.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
  return JSON.parse(new TextDecoder().decode(request.body.body));
}

it("accepts Jira Cloud hosts and rejects non-tenant destinations", () => {
  expect(JiraApi.normalizeJiraHost("https://EXAMPLE.atlassian.net/")).toBe("example.atlassian.net");
  for (const host of [
    "http://example.atlassian.net",
    "example.atlassian.net.evil.test",
    "https://user:secret@example.atlassian.net",
    "example.atlassian.net:444",
    "example.atlassian.net/path",
    "api.atlassian.com",
  ])
    expect(() => JiraApi.normalizeJiraHost(host)).toThrow();
});

it.effect(
  "probes native identity before listing projects and returns the real site and account ID",
  () =>
    Effect.gen(function* () {
      const f = fakeJira(
        (request) => ({
          body: request.url.endsWith("/myself")
            ? user
            : { startAt: 0, total: 1, values: [{ id: "20", key: "ENG", name: "Engineering" }] },
        }),
        null,
      );
      const api = yield* f.api;
      const result = yield* api.probeCredential(packed);
      expect(result).toMatchObject({
        account: "Ada",
        accountId: "native-account",
        host: "example.atlassian.net",
        scopes: [{ key: "ENG", name: "Engineering" }],
      });
      expect(f.calls[0]?.url).toContain("/myself");
      expect(f.calls[0]?.headers.authorization).toBe(
        "Basic " + Buffer.from("ada@example.test:fake-token").toString("base64"),
      );
    }),
);

it.effect("checks the saved site before any request and reads updated credentials fresh", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: user }));
    const api = yield* f.api;
    const wrong = yield* api
      .getViewer({ cwd: target.cwd, host: "other.atlassian.net" })
      .pipe(Effect.flip);
    expect(wrong.reason).toBe("unauthenticated");
    expect(f.calls).toHaveLength(0);
    yield* api.getViewer(target);
    f.store(JSON.stringify({ site: target.host, email: "ada@example.test", token: "next-token" }));
    yield* api.getViewer(target);
    expect(f.calls[1]?.headers.authorization).toBe(
      "Basic " + Buffer.from("ada@example.test:next-token").toString("base64"),
    );
  }),
);

it.effect("makes one enhanced search request for open issues and preserves native cursors", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: { issues: [issue], nextPageToken: "native-next", isLast: false },
    }));
    const api = yield* f.api;
    const result = yield* api.listIssues({
      ...target,
      state: "open",
      involvement: "authored",
      viewer: "native-account",
      limit: 100,
      cursor: "native-prior",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toContain("/search/jql");
    expect(body(f.calls[0])).toMatchObject({
      jql: 'project = "ENG" AND statusCategory != "done" AND creator = currentUser() ORDER BY updated DESC',
      maxResults: 100,
      nextPageToken: "native-prior",
    });
    expect(result.nextCursor).toBe("native-next");
    expect(result.items[0]?.state).toEqual({ name: "Review", category: "open" });
    expect(result.items[0]?.author?.id).toBe("native-account");
  }),
);

it.effect(
  "reads real permissions, ADF, comments and mapped history without inventing PR links",
  () =>
    Effect.gen(function* () {
      const f = fakeJira((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/myself")) return { body: user };
        if (url.pathname.endsWith("/mypermissions"))
          return {
            body: {
              permissions: {
                EDIT_ISSUES: { havePermission: true },
                ADD_COMMENTS: { havePermission: true },
                ASSIGN_ISSUES: { havePermission: false },
                TRANSITION_ISSUES: { havePermission: true },
              },
            },
          };
        if (url.pathname.endsWith("/transitions"))
          return {
            body: {
              transitions: [
                {
                  id: "done-transition",
                  to: { id: "3", name: "Done", statusCategory: { key: "done" } },
                },
              ],
            },
          };
        if (url.pathname.endsWith("/comment"))
          return {
            body: {
              startAt: 0,
              total: 4,
              comments: [
                {
                  id: "4",
                  author: user,
                  created: "2026-10-14T11:00:00Z",
                  updated: "2026-10-14T11:00:00Z",
                  body: issue.fields.description,
                },
              ],
            },
          };
        if (url.pathname.endsWith("/changelog"))
          return {
            body: {
              values: [
                {
                  id: "history",
                  author: null,
                  created: "2026-10-14T10:00:00Z",
                  items: [{ field: "status" }],
                },
              ],
            },
          };
        return { body: issue };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(result.body).toBe("body");
      expect(result.bodyEditable).toBe(true);
      expect(result.viewer).toBe("native-account");
      expect(result.viewerPermissions).toEqual({
        edit: true,
        labels: true,
        comment: true,
        assignees: false,
        setState: true,
      });
      expect(result.comments[0]?.author?.id).toBe("native-account");
      expect(result.commentsCursor).toBe("1");
      expect(result.events[0]).toMatchObject({ kind: "state-changed", detail: null });
      expect(result.linkedPullRequests).toEqual([]);
    }),
);

it.effect("blocks foreign-project writes and rejects multiple assignees", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: { ...issue, fields: { ...issue.fields, project: { id: "30", key: "OTHER" } } },
    }));
    const api = yield* f.api;
    const failure = yield* api.update!({ ...target, labels: ["bug"] }).pipe(Effect.flip);
    expect(failure.reason).toBe("not-found");
    expect(f.calls.every((request) => request.method === "GET")).toBe(true);
    for (const assignees of [[user.accountId], []]) {
      f.calls.length = 0;
      expect((yield* api.update!({ ...target, assignees }).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.method).toBe("GET");
    }
    f.calls.length = 0;
    const many = yield* api.update!({ ...target, assignees: ["one", "two"] }).pipe(Effect.flip);
    expect(many.reason).toBe("failed");
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("uses an explicit native issue type and omits fields absent from the create screen", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      if (request.method === "POST") return { status: 201, body: { key: "ENG-2" } };
      return {
        body: request.url.includes("/issuetypes/bug?")
          ? { startAt: 0, total: 1, fields: [{ fieldId: "summary", required: true }] }
          : {
              startAt: 0,
              total: 2,
              issueTypes: [
                { id: "task", name: "Task" },
                { id: "bug", name: "Bug" },
              ],
            },
      };
    });
    const api = yield* f.api;
    const result = yield* api.create!({
      ...target,
      title: "New bug",
      body: "",
      labels: [],
      assignees: [],
      issueType: "bug",
    });
    expect(result.key).toBe("ENG-2");
    expect(body(f.calls[2])).toEqual({
      fields: { project: { key: "ENG" }, issuetype: { id: "bug" }, summary: "New bug" },
    });
  }),
);

it.effect("does not create an issue that needs unsupported required fields", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/issuetypes/task?")
        ? { startAt: 0, total: 1, fields: [{ fieldId: "customfield_1", required: true }] }
        : { startAt: 0, total: 1, issueTypes: [{ id: "task", name: "Task" }] },
    }));
    const api = yield* f.api;
    const result = yield* api.create!({
      ...target,
      title: "Task",
      body: "",
      labels: [],
      assignees: [],
    }).pipe(Effect.flip);
    expect(result.detail).toContain("extra required fields");
    expect(f.calls.every((request) => request.method === "GET")).toBe(true);
  }),
);

it.effect("uses native transition IDs and refuses ambiguous or required-field workflows", () =>
  Effect.gen(function* () {
    const destination = { id: "3", name: "Done", statusCategory: { key: "done" } };
    const f = fakeJira((request) =>
      request.method === "POST"
        ? { status: 204 }
        : {
            body: request.url.includes("/transitions?")
              ? { transitions: [{ id: "native-42", to: destination }] }
              : issue,
          },
    );
    const api = yield* f.api;
    yield* api.setState!({ ...target, state: "closed" });
    expect(body(f.calls[2])).toEqual({ transition: { id: "native-42" } });
    const ambiguous = fakeJira((request) => ({
      body: request.url.includes("/transitions?")
        ? {
            transitions: [
              { id: "a", to: destination },
              { id: "b", to: destination },
            ],
          }
        : issue,
    }));
    const other = yield* ambiguous.api;
    yield* other.setState!({ ...target, state: "closed" }).pipe(Effect.flip);
    expect(ambiguous.calls.every((request) => request.method === "GET")).toBe(true);
  }),
);

it.effect(
  "keeps candidate labels inside the project and marks filtered user windows incomplete",
  () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 121 }, (_, index) => "label-" + index);
      const f = fakeJira((request) => ({
        body: request.url.includes("/mypermissions?")
          ? {
              permissions: {
                ASSIGN_ISSUES: { havePermission: true },
                CREATE_ISSUES: { havePermission: true },
              },
            }
          : request.url.includes("/search/jql")
            ? { issues: [{ fields: { project: { id: "20", key: "ENG" }, labels } }] }
            : request.url.includes("/user/assignable/search?")
              ? []
              : { startAt: 0, total: 1, issueTypes: [{ id: "task", name: "Task" }] },
      }));
      const api = yield* f.api;
      const candidates = yield* api.listCandidates!(target);
      expect(candidates.labels.map((label) => label.name)).toEqual(labels.slice(0, 100));
      expect(candidates.assignees).toEqual([]);
      expect(candidates.issueTypes).toEqual([{ id: "task", name: "Task" }]);
      expect(candidates.truncated).toBe(true);
      expect(f.calls.some((request) => new URL(request.url).pathname.endsWith("/label"))).toBe(
        false,
      );
    }),
);

it.effect("reports rate limit headers and excludes credential and API error body data", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      status: 429,
      body: { error: "fake-token" },
      headers: { "retry-after": "60" },
    }));
    const api = yield* f.api;
    const error = yield* api.getViewer(target).pipe(Effect.flip);
    expect(error.reason).toBe("rate-limited");
    expect(error.retryAt).toBeTypeOf("number");
    expect(JSON.stringify(error)).not.toContain("fake-token");
  }),
);

it.effect("bounds response bodies and request time", () =>
  Effect.gen(function* () {
    const huge = fakeJira(() => ({ body: { padding: "x".repeat(2 * 1024 * 1024) } }));
    const api = yield* huge.api;
    const failure = yield* api.getViewer(target).pipe(Effect.flip);
    expect(failure.detail).toContain("oversized");
    const pending = fakeJira(() => ({ pending: true }));
    const other = yield* pending.api;
    const request = yield* other.getViewer(target).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("31 seconds");
    expect((yield* Fiber.join(request)).detail).toBe("Jira request timed out.");
  }),
);

it.effect("loads embedded conversation and history with only three detail requests", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/myself")) return { body: user };
      if (url.pathname.endsWith("/mypermissions"))
        return {
          body: {
            permissions: {
              EDIT_ISSUES: { havePermission: true },
              TRANSITION_ISSUES: { havePermission: true },
            },
          },
        };
      return {
        body: {
          ...issue,
          changelog: {
            histories: [
              {
                id: "event",
                created: "2026-10-14T10:00:00Z",
                items: [{ field: "summary", toString: "Task" }],
              },
            ],
          },
          fields: {
            ...issue.fields,
            comment: {
              total: 4,
              startAt: 0,
              comments: [
                {
                  id: "one",
                  author: user,
                  body: issue.fields.description,
                  created: "2026-10-14T10:00:00Z",
                  updated: "2026-10-14T10:00:00Z",
                },
              ],
            },
          },
        },
      };
    });
    const api = yield* f.api;
    const result = yield* api.getIssue(target);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]?.url).toContain("expand=changelog");
    expect(result.commentsCursor).toBe("1");
    expect(result.events[0]).toMatchObject({ kind: "renamed", detail: "Task" });
    expect(result.comments[0]?.body).toBe("body");
  }),
);

it.effect("loads older comments after Jira's latest embedded page without gaps or duplicates", () =>
  Effect.gen(function* () {
    const nativeComments = Array.from({ length: 150 }, (_, index) => ({
      id: String(index + 1),
      author: user,
      body: issue.fields.description,
      created: `2026-10-14T${10 + Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}:00Z`,
      updated: issue.fields.updated,
    }));
    for (const embeddedCount of [100, 20]) {
      const offsets: number[] = [];
      const f = fakeJira((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/myself")) return { body: user };
        if (url.pathname.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (url.pathname.endsWith("/comment")) {
          expect(url.searchParams.get("orderBy")).toBe("-created");
          expect(url.searchParams.get("maxResults")).toBe("50");
          const startAt = Number(url.searchParams.get("startAt"));
          offsets.push(startAt);
          return {
            body: {
              startAt,
              total: 150,
              comments: nativeComments.toReversed().slice(startAt, startAt + 50),
            },
          };
        }
        return {
          body: {
            ...issue,
            changelog: { histories: [] },
            fields: {
              ...issue.fields,
              comment: {
                startAt: 0,
                total: 150,
                comments: nativeComments.slice(-embeddedCount),
              },
            },
          },
        };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(f.calls).toHaveLength(3);
      expect(result.commentsCursor).toBe(String(embeddedCount));
      const loaded = [...result.comments];
      let cursor = result.commentsCursor;
      while (cursor !== null) {
        const page = yield* api.getComments({ ...target, cursor });
        const ids = page.comments.map((comment) => Number(comment.id));
        expect(ids).toEqual(ids.toSorted((a, b) => a - b));
        loaded.unshift(...page.comments);
        cursor = page.nextCursor;
      }
      expect(offsets).toEqual(embeddedCount === 100 ? [100] : [20, 70, 120]);
      expect(loaded.map((comment) => comment.id)).toEqual(
        nativeComments.map((comment) => comment.id),
      );
    }
  }),
);

it.effect("keeps complete and empty embedded comment sets without another request", () =>
  Effect.gen(function* () {
    for (const comment of [
      { startAt: 0, total: 0, comments: [] },
      { total: 0 },
      {
        startAt: 0,
        total: 1,
        comments: [
          {
            id: "1",
            body: issue.fields.description,
            created: issue.fields.created,
            updated: issue.fields.updated,
          },
        ],
      },
    ]) {
      const f = fakeJira((request) => {
        if (request.url.includes("/myself")) return { body: user };
        if (request.url.includes("/mypermissions")) return { body: { permissions: {} } };
        return {
          body: {
            ...issue,
            changelog: { histories: [] },
            fields: { ...issue.fields, comment },
          },
        };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(result.comments).toHaveLength(comment.total);
      expect(result.commentsCursor).toBeNull();
      expect(f.calls).toHaveLength(3);
    }
  }),
);

it.effect("starts comment paging with the latest comments in ascending display order", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      if (!request.url.includes("/comment?")) return { body: issue };
      const url = new URL(request.url);
      expect(url.searchParams.get("orderBy")).toBe("-created");
      expect(url.searchParams.get("startAt")).toBe("0");
      return {
        body: {
          startAt: 0,
          total: 4,
          comments: [4, 3, 2].map((id) => ({
            id: String(id),
            body: issue.fields.description,
            created: issue.fields.created,
            updated: issue.fields.updated,
          })),
        },
      };
    });
    const api = yield* f.api;
    const page = yield* api.getComments({ ...target, cursor: "0" });
    expect(page.comments.map((comment) => comment.id)).toEqual(["2", "3", "4"]);
    expect(page.nextCursor).toBe("3");
  }),
);

it.effect.each([user.accountId, null])(
  "assigns through native assignment rights without edit permission: %s",
  (accountId) =>
    Effect.gen(function* () {
      const f = fakeJira((request) => {
        if (request.url.includes("/mypermissions?"))
          return {
            body: {
              permissions: {
                EDIT_ISSUES: { havePermission: false },
                ASSIGN_ISSUES: { havePermission: true },
              },
            },
          };
        if (request.method === "GET") return { body: issue };
        if (!request.url.endsWith("/issue/ENG-1/assignee")) return { status: 403 };
        expect(body(request)).toEqual({ accountId });
        return { status: 204 };
      });
      const api = yield* f.api;
      expect(yield* api.getViewerPermissions(target)).toMatchObject({
        edit: false,
        assignees: true,
      });
      yield* api.update!({ ...target, assignees: accountId === null ? [] : [accountId] });
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
      expect(f.calls[1]?.url).toBe(
        "https://example.atlassian.net/rest/api/3/issue/ENG-1?fields=project,status",
      );
      expect(f.calls[2]?.url).toBe("https://example.atlassian.net/rest/api/3/issue/ENG-1/assignee");
      expect(body(f.calls[2])).toEqual({ accountId });
    }),
);

it.effect("preserves a native assignment denial without retrying or changing endpoints", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => (request.method === "GET" ? { body: issue } : { status: 403 }));
    const api = yield* f.api;
    const failure = yield* api.update!({ ...target, assignees: [user.accountId] }).pipe(
      Effect.flip,
    );
    expect(failure).toMatchObject({ operation: "update", reason: "failed" });
    expect(failure.detail).toContain("403");
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "PUT"]);
    expect(f.calls[1]?.url).toBe("https://example.atlassian.net/rest/api/3/issue/ENG-1/assignee");
    expect(body(f.calls[1])).toEqual({ accountId: user.accountId });
  }),
);

it.effect.each([user.accountId, null])(
  "keeps combined assignment edits on the issue endpoint: %s",
  (accountId) =>
    Effect.gen(function* () {
      const f = fakeJira((request) =>
        request.method === "PUT"
          ? { status: 204 }
          : {
              body: request.url.includes("/mypermissions?")
                ? {
                    permissions: {
                      EDIT_ISSUES: { havePermission: true },
                      ASSIGN_ISSUES: { havePermission: true },
                    },
                  }
                : issue,
            },
      );
      const api = yield* f.api;
      expect((yield* api.getViewerPermissions(target)).edit).toBe(true);
      yield* api.update!({
        ...target,
        labels: ["triaged"],
        assignees: accountId === null ? [] : [accountId],
      });
      expect(f.calls).toHaveLength(3);
      expect(f.calls[1]?.url).toContain("?fields=project,status");
      expect(body(f.calls[2])).toEqual({
        fields: { labels: ["triaged"], assignee: accountId === null ? null : { accountId } },
      });
      expect(f.calls[2]?.url).toBe("https://example.atlassian.net/rest/api/3/issue/ENG-1");
      expect(f.calls.some((request) => request.url.includes("/transitions"))).toBe(false);
    }),
);

it.effect("preserves a bodyless 429 and pauses only the refused credential", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 429, headers: { "retry-after": "60" } }));
    const api = yield* f.api;
    expect((yield* api.getViewer(target).pipe(Effect.flip)).reason).toBe("rate-limited");
    expect((yield* api.getViewer(target).pipe(Effect.flip)).reason).toBe("rate-limited");
    expect(f.calls).toHaveLength(1);
    f.store(
      JSON.stringify({
        site: target.host,
        email: "ada@example.test",
        token: "another-account-token",
      }),
    );
    yield* api.getViewer(target).pipe(Effect.flip);
    expect(f.calls).toHaveLength(2);
  }),
);

it.effect.each(["title", "body", "labels"] as const)(
  "keeps empty mixed field edits on the issue endpoint: %s",
  (field) =>
    Effect.gen(function* () {
      const updates = { title: { title: "" }, body: { body: "" }, labels: { labels: [] } };
      const fields = {
        title: { summary: "" },
        body: {
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [] }],
          },
        },
        labels: { labels: [] },
      };
      const f = fakeJira((request) =>
        request.method === "GET" ? { body: issue } : { status: 204 },
      );
      const api = yield* f.api;
      yield* api.update!({ ...target, ...updates[field], assignees: [user.accountId] });
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "PUT"]);
      expect(f.calls[1]?.url).toBe("https://example.atlassian.net/rest/api/3/issue/ENG-1");
      expect(body(f.calls[1])).toEqual({
        fields: { ...fields[field], assignee: { accountId: user.accountId } },
      });
    }),
);

it.effect(
  "connects a large Jira project catalog and verifies a missing project with one direct read",
  () =>
    Effect.gen(function* () {
      const projects = Array.from({ length: 100 }, (_, index) => ({
        id: String(index + 1),
        key: "PRJ" + index,
        name: "Project " + index,
      }));
      const f = fakeJira(
        (request) => ({
          body: request.url.endsWith("/myself")
            ? user
            : request.url.includes("/project/search?")
              ? { startAt: 0, total: 101, values: projects }
              : { key: "ENG", name: "Engineering" },
        }),
        null,
      );
      const api = yield* f.api;
      const catalog = yield* api.probeCredential(packed);
      expect(catalog.scopes).toHaveLength(100);
      expect(catalog).toMatchObject({
        scopesTruncated: true,
        accountId: "native-account",
        host: target.host,
      });
      const scope = yield* api.getScope!(packed, "101");
      expect(scope).toEqual({ key: "ENG", name: "Engineering" });
      expect(f.calls).toHaveLength(3);
      expect(f.calls[2]?.url).toBe("https://example.atlassian.net/rest/api/3/project/101");
    }),
);

it.effect("returns no fabricated scope when Jira denies or cannot find a project", () =>
  Effect.gen(function* () {
    const missing = fakeJira(() => ({ status: 404 }));
    const api = yield* missing.api;
    expect(yield* api.getScope!(packed, "MISSING")).toBeNull();
    expect(missing.calls).toHaveLength(1);
    const denied = fakeJira(() => ({ status: 403 }));
    const other = yield* denied.api;
    expect((yield* other.getScope!(packed, "PRIVATE").pipe(Effect.flip)).reason).toBe("failed");
    expect(denied.calls).toHaveLength(1);
  }),
);

it.effect("marks bounded native history pages as partial without fetching more", () =>
  Effect.gen(function* () {
    const histories = ["one", "two"].map((id) => ({
      id,
      created: "2026-10-14T10:00:00Z",
      items: [{ field: "summary", toString: id }],
    }));
    for (const test of [
      { embedded: true, total: 200, isLast: true, truncated: true },
      { embedded: false, total: 200, isLast: true, truncated: true },
      { embedded: false, total: 2, isLast: false, truncated: true },
      { embedded: false, total: 2, isLast: true, truncated: false },
    ]) {
      const f = fakeJira((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/myself")) return { body: user };
        if (path.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (path.endsWith("/changelog"))
          return {
            body: { startAt: 0, total: test.total, isLast: test.isLast, values: histories },
          };
        return {
          body: {
            ...issue,
            fields: { ...issue.fields, comment: { total: 0, comments: [] } },
            ...(test.embedded ? { changelog: { startAt: 0, total: test.total, histories } } : {}),
          },
        };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(result.events).toHaveLength(2);
      expect(result.historyTruncated ?? false).toBe(test.truncated);
      expect(f.calls).toHaveLength(test.embedded ? 3 : 4);
    }
  }),
);

it.effect("refuses rich body edits in the existing scope read and preserves title edits", () =>
  Effect.gen(function* () {
    const description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "native-account", text: "@Ada" } },
            { type: "text", text: " body", marks: [{ type: "strong" }] },
          ],
        },
      ],
    };
    const f = fakeJira((request) =>
      request.method === "GET"
        ? { body: { ...issue, fields: { ...issue.fields, description } } }
        : { status: 204 },
    );
    const api = yield* f.api;
    const failure = yield* api.update!({ ...target, body: "@Ada body!" }).pipe(Effect.flip);
    expect(failure).toMatchObject({ operation: "update", reason: "failed" });
    expect(failure.detail).toContain("Jira");
    expect(f.calls).toHaveLength(1);
    expect(new URL(f.calls[0]!.url).searchParams.get("fields")).toBe("project,status,description");
    yield* api.update!({ ...target, title: "Safe title" });
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
    expect(new URL(f.calls[1]!.url).searchParams.get("fields")).toBe("project,status");
    expect(body(f.calls[2])).toEqual({ fields: { summary: "Safe title" } });
  }),
);

it.effect("writes plain bodies with two native calls and preserves native write denial", () =>
  Effect.gen(function* () {
    for (const status of [204, 403]) {
      const f = fakeJira((request) => (request.method === "GET" ? { body: issue } : { status }));
      const api = yield* f.api;
      const result = yield* Effect.result(api.update!({ ...target, body: "changed" }));
      expect(result._tag).toBe(status === 204 ? "Success" : "Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("403");
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "PUT"]);
      expect(new URL(f.calls[0]!.url).searchParams.get("fields")).toBe(
        "project,status,description",
      );
      expect(body(f.calls[1])).toEqual({
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }],
          },
        },
      });
    }
  }),
);

it.effect("reads rich native task text while refusing to overwrite its IDs and state", () =>
  Effect.gen(function* () {
    const description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "taskList",
          attrs: { localId: "list-id" },
          content: [
            {
              type: "taskItem",
              attrs: { localId: "item-id", state: "TODO" },
              content: [{ type: "text", text: "Do this" }],
            },
          ],
        },
      ],
    };
    const f = fakeJira((request) => {
      if (request.url.endsWith("/myself")) return { body: user };
      if (request.url.includes("/mypermissions?"))
        return { body: { permissions: { EDIT_ISSUES: { havePermission: true } } } };
      return {
        body: {
          ...issue,
          changelog: { total: 0, histories: [] },
          fields: { ...issue.fields, description, comment: { total: 0, comments: [] } },
        },
      };
    });
    const api = yield* f.api;
    const detail = yield* api.getIssue(target);
    expect(detail.body).toBe("- [ ] Do this");
    expect(detail.bodyEditable).toBe(false);
    expect(detail.viewerPermissions.edit).toBe(true);
    f.calls.length = 0;
    expect((yield* api.update!({ ...target, body: "changed" }).pipe(Effect.flip)).reason).toBe(
      "failed",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe("GET");
  }),
);

it.effect.each([
  undefined,
  { type: "doc", version: 1, content: [{ type: "unknownNode" }] },
  { type: "doc", version: 1, content: [{ type: "paragraph", content: "invalid" }] },
])("refuses body writes when the current description is missing or malformed: %j", (description) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { ...issue, fields: { ...issue.fields, description } } }));
    const api = yield* f.api;
    expect((yield* api.update!({ ...target, body: "changed" }).pipe(Effect.flip)).reason).toBe(
      "failed",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe("GET");
  }),
);
