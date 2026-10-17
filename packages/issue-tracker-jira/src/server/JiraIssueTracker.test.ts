import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { IssueSummary, IssueTrackerKind, IssueTrackerScopePage } from "@t3tools/contracts";
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
const decodeIssueSummary = Schema.decodeEffect(IssueSummary);
const decodeScopePage = Schema.decodeEffect(IssueTrackerScopePage);
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
    const response = request.url.endsWith("/remotelink") ? { body: [] } : reply(request);
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

it.effect("continues a selected Jira account project catalog with one request per page", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      if (request.url.endsWith("/myself")) return { body: user };
      const url = new URL(request.url);
      const startAt = Number(url.searchParams.get("startAt"));
      const limit = Number(url.searchParams.get("maxResults"));
      return {
        body: {
          startAt,
          total: 202,
          values: Array.from({ length: Math.min(limit, 202 - startAt) }, (_, index) => ({
            id: String(startAt + index),
            key: `PRJ${startAt + index}`,
            name: `Project ${startAt + index}`,
          })),
        },
      };
    }, null);
    const api = yield* f.api;
    const initial = yield* api.probeCredential(packed);
    expect(initial.scopesCursor).toBe("100");
    expect(initial.scopes).toHaveLength(100);
    f.store(
      JSON.stringify({ site: target.host, email: "other@example.test", token: "other-token" }),
    );
    const page = yield* api.listScopes!(packed, { cursor: initial.scopesCursor! });
    expect(page.items).toHaveLength(100);
    expect(page.items[0]).toEqual({ key: "PRJ100", name: "Project 100" });
    expect(page.nextCursor).toBe("200");
    expect(
      yield* decodeScopePage(
        yield* api.listScopes!(packed, { cursor: page.nextCursor!, limit: 2 }),
      ),
    ).toEqual({
      items: [
        { key: "PRJ200", name: "Project 200" },
        { key: "PRJ201", name: "Project 201" },
      ],
      nextCursor: null,
    });
    expect(f.calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/rest/api/3/myself",
      ...Array(3).fill("/rest/api/3/project/search"),
    ]);
    expect(f.calls.map(({ headers }) => headers.authorization)).toEqual(
      Array(4).fill("Basic " + Buffer.from("ada@example.test:fake-token").toString("base64")),
    );
    expect(f.calls.slice(1).map(({ url }) => new URL(url).search)).toEqual([
      "?startAt=0&maxResults=100",
      "?startAt=100&maxResults=100",
      "?startAt=200&maxResults=2",
    ]);
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  }),
);

it.effect("advances a short Jira scope page by the returned project count", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: { startAt: 100, total: 102, values: [{ id: "100", key: "ENG", name: "Engineering" }] },
    }));
    const api = yield* f.api;
    expect(yield* api.listScopes!(packed, { cursor: "100", limit: 100 })).toEqual({
      items: [{ key: "ENG", name: "Engineering" }],
      nextCursor: "101",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toContain("startAt=100&maxResults=100");
  }),
);

it.effect.each([
  { cursor: "" },
  { cursor: "01" },
  { cursor: "-1" },
  { cursor: "1.5" },
  { cursor: "https://foreign.test/page" },
  { cursor: "9007199254740992" },
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
])("rejects invalid Jira scope paging before HTTP: %j", (input) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: {} }));
    const api = yield* f.api;
    expect((yield* api.listScopes!(packed, input).pipe(Effect.flip)).reason).toBe("failed");
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect.each([
  { startAt: 0, total: 101, count: 1 },
  { startAt: 100, total: -1, count: 0 },
  { startAt: 100, total: 100, count: 1 },
  { startAt: 100, total: 101, count: 0 },
  { startAt: 100, total: 102, count: 2 },
])("refuses inconsistent Jira scope pages: %j", ({ count, ...page }) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        ...page,
        values: Array.from({ length: count }, () => ({ id: "1", key: "ENG", name: "Engineering" })),
      },
    }));
    const api = yield* f.api;
    expect(
      (yield* api.listScopes!(packed, { cursor: "100", limit: 1 }).pipe(Effect.flip)).reason,
    ).toBe("failed");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toContain("/project/search?");
  }),
);

it.effect("refuses an empty nonterminal Jira probe and accepts an empty terminal page", () =>
  Effect.gen(function* () {
    let total = 1;
    const f = fakeJira((request) => ({
      body: request.url.endsWith("/myself") ? user : { startAt: 0, total, values: [] },
    }));
    const api = yield* f.api;
    expect((yield* api.probeCredential(packed).pipe(Effect.flip)).reason).toBe("failed");
    expect(f.calls).toHaveLength(2);
    total = 0;
    expect(yield* api.listScopes!(packed, {})).toEqual({ items: [], nextCursor: null });
    expect(f.calls).toHaveLength(3);
  }),
);

it.effect.each([403, 429])("preserves native Jira scope error %s without viewer reads", (status) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status }));
    const api = yield* f.api;
    const error = yield* api.listScopes!(packed, { cursor: "100" }).pipe(Effect.flip);
    expect(error.reason).toBe(status === 429 ? "rate-limited" : "failed");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toContain("/project/search?");
  }),
);

it.effect.each([
  { fixVersions: undefined },
  { fixVersions: [] },
  { fixVersions: [{ name: "Version 7" }] },
  { fixVersions: [{ name: "Version 7" }, { name: "Version 8" }] },
])("retains native fix versions in list, detail, and wire summaries: %j", ({ fixVersions }) =>
  Effect.gen(function* () {
    const native = {
      ...issue,
      changelog: { startAt: 0, total: 0, histories: [] },
      fields: { ...issue.fields, fixVersions, comment: { total: 0, startAt: 0, comments: [] } },
    };
    const f = fakeJira((request) => {
      if (request.url.includes("/search/jql")) return { body: { issues: [native], isLast: true } };
      if (request.url.endsWith("/myself")) return { body: user };
      if (request.url.includes("/mypermissions?")) return { body: { permissions: {} } };
      return { body: native };
    });
    const api = yield* f.api;
    const page = yield* api.listIssues({
      ...target,
      state: "all",
      involvement: "all",
      viewer: user.accountId,
      limit: 20,
    });
    expect(f.calls).toHaveLength(1);
    const detail = yield* api.getIssue(target);
    const milestone = fixVersions?.map(({ name }) => name).join(", ") || null;
    for (const summary of [page.items[0]!, detail]) {
      expect(summary.milestone).toBe(milestone);
      const wire = yield* decodeIssueSummary({
        ...summary,
        tracker: IssueTrackerKind.make("jira"),
        host: target.host,
        scope: target.scope,
      });
      expect(wire.milestone).toBe(milestone);
    }
    expect(f.calls).toHaveLength(5);
    expect(body(f.calls[0])).toMatchObject({ fields: expect.arrayContaining(["fixVersions"]) });
    expect(new URL(f.calls[1]!.url).searchParams.get("fields")?.split(",")).toContain(
      "fixVersions",
    );
    expect(f.calls.map(({ method }) => method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
  }),
);

it.effect.each([null, 100, 101])(
  "enforces the native fix-version shape and saved 100-version limit: %s",
  (count) =>
    Effect.gen(function* () {
      const fixVersions =
        count === null ? null : Array.from({ length: count }, () => ({ name: "Version" }));
      const f = fakeJira(() => ({
        body: { issues: [{ ...issue, fields: { ...issue.fields, fixVersions } }], isLast: true },
      }));
      const api = yield* f.api;
      const request = api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: user.accountId,
        limit: 20,
      });
      if (count === 100)
        expect((yield* request).items[0]?.milestone).toBe(
          fixVersions?.map(({ name }) => name).join(", "),
        );
      else expect((yield* request.pipe(Effect.flip)).reason).toBe("failed");
      expect(f.calls).toHaveLength(1);
    }),
);

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
    expect(result.items[0]?.state).toMatchObject({ name: "Review", category: "open" });
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
              startAt: 0,
              total: 1,
              isLast: true,
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
      expect(
        result.commentsCursor === null ? null : JSON.parse(result.commentsCursor).position,
      ).toBe(1);
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
    const many = yield* api.update!({ ...target, assignees: ["one", "two"] }).pipe(Effect.flip);
    expect(many.reason).toBe("failed");
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect.each([
  { key: undefined, denied: false },
  { key: "ENG-1", denied: false },
  { key: "ENG-1", denied: true },
])("scopes native state choices without losing other metadata: %j", ({ key, denied }) =>
  Effect.gen(function* () {
    const done = { id: "3", name: "Done", statusCategory: { key: "done" } };
    const verified = { id: "9", name: "Verified", statusCategory: { key: "done" } };
    const duplicate = { ...done, id: "6", name: "Ambiguous" };
    const available = [
      { id: "task-done", to: done, isAvailable: true, fields: { note: { required: false } } },
      { id: "unavailable", to: { ...done, id: "4", name: "Unavailable" }, isAvailable: false },
      {
        id: "required",
        to: { ...done, id: "5", name: "Signoff" },
        fields: { resolution: { required: true } },
      },
      { id: "duplicate-a", to: duplicate },
      { id: "duplicate-b", to: duplicate, fields: { resolution: { required: true } } },
    ];
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/mypermissions")) {
        expect(url.searchParams.get(key === undefined ? "projectKey" : "issueKey")).toBe(
          key ?? target.scope,
        );
        return {
          body: {
            permissions: {
              CREATE_ISSUES: { havePermission: true },
              ASSIGN_ISSUES: { havePermission: true },
              TRANSITION_ISSUES: { havePermission: true },
            },
          },
        };
      }
      if (url.pathname.endsWith("/search/jql"))
        return {
          body: { issues: [{ fields: { project: issue.fields.project, labels: ["triaged"] } }] },
        };
      if (url.pathname.endsWith("/user/assignable/search")) return { body: [user] };
      if (url.pathname.includes("/createmeta/"))
        return {
          body: {
            startAt: 0,
            total: 1,
            issueTypes: [{ id: "task", name: "Task" }],
          },
        };
      if (url.pathname.endsWith("/statuses"))
        return {
          body: [
            { id: "task", statuses: [issue.fields.status, done] },
            { id: "bug", statuses: [verified] },
          ],
        };
      if (url.pathname.endsWith("/transitions")) {
        if (request.method === "GET") {
          expect(url.searchParams.get("expand")).toBe("transitions.fields");
          expect(url.searchParams.has("includeUnavailableTransitions")).toBe(false);
          return { body: { transitions: available } };
        }
        expect(body(request)).toEqual({ transition: { id: "task-done" } });
        return { status: denied ? 403 : 204 };
      }
      expect(url.pathname).toBe("/rest/api/3/issue/ENG-1");
      expect(url.searchParams.get("fields")).toBe("project,status");
      return { body: issue };
    });
    const api = yield* f.api;
    const candidates = yield* api.listCandidates!({
      cwd: target.cwd,
      host: target.host,
      scope: target.scope,
      key,
    });
    expect(candidates.states?.map(({ id }) => id)).toEqual(
      key === undefined ? ["2", "3", "9"] : ["3", "5", "6", "6"],
    );
    expect(candidates.labels.map(({ name }) => name)).toEqual(["triaged"]);
    expect(candidates.assignees).toMatchObject([{ id: user.accountId }]);
    expect(candidates.issueTypes).toEqual([{ id: "task", name: "Task" }]);
    expect(candidates.truncated).toBe(true);
    expect(f.calls).toHaveLength(key === undefined ? 5 : 6);
    expect(
      f.calls.some(({ method, url }) => method === "POST" && url.includes("/transitions")),
    ).toBe(false);
    if (key !== undefined) {
      expect(f.calls.some(({ url }) => url.includes("/project/ENG/statuses"))).toBe(false);
      const action = api.setState!({ ...target, state: candidates.states![0]!.id! });
      if (denied) expect((yield* action.pipe(Effect.flip)).detail).toContain("403");
      else yield* action;
      expect(f.calls).toHaveLength(9);
      expect(f.calls[8]?.method).toBe("POST");
      expect(body(f.calls[8])).toEqual({ transition: { id: "task-done" } });
    }
  }),
);

it.effect.each(["foreign", "missing", "permissions", "transitions"] as const)(
  "refuses invalid issue candidate reads before any mutation: %s",
  (failure) =>
    Effect.gen(function* () {
      const f = fakeJira((request) => {
        if (request.url.includes("/mypermissions?"))
          return failure === "permissions" ? { status: 403 } : { body: { permissions: {} } };
        if (request.url.includes("/transitions?")) return { status: 403 };
        if (failure === "missing") return { status: 404 };
        return {
          body:
            failure === "foreign"
              ? { ...issue, fields: { ...issue.fields, project: { id: "30", key: "OPS" } } }
              : issue,
        };
      });
      const api = yield* f.api;
      const error = yield* api.listCandidates!(target).pipe(Effect.flip);
      expect(error.reason).toBe(
        failure === "foreign" || failure === "missing" ? "not-found" : "failed",
      );
      expect(f.calls).toHaveLength(
        failure === "transitions" ? 3 : failure === "permissions" ? 2 : 1,
      );
      expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    }),
);

it.effect("keeps label metadata when native transition permissions return no choices", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/mypermissions?")
        ? {
            permissions: {
              TRANSITION_ISSUES: { havePermission: false },
              ASSIGN_ISSUES: { havePermission: false },
              CREATE_ISSUES: { havePermission: false },
            },
          }
        : request.url.includes("/transitions?")
          ? { transitions: [] }
          : request.url.includes("/search/jql")
            ? { issues: [{ fields: { project: issue.fields.project, labels: ["triaged"] } }] }
            : issue,
    }));
    const api = yield* f.api;
    const candidates = yield* api.listCandidates!(target);
    expect(candidates).toMatchObject({
      states: [],
      labels: [{ name: "triaged" }],
      assignees: [],
      issueTypes: [],
    });
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "POST"]);
    expect(f.calls.some(({ url }) => url.includes("/statuses") || url.includes("/myself"))).toBe(
      false,
    );
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
            : request.url.endsWith("/statuses")
              ? [{ statuses: [issue.fields.status] }]
              : request.url.includes("/user/assignable/search?")
                ? []
                : { startAt: 0, total: 1, issueTypes: [{ id: "task", name: "Task" }] },
      }));
      const api = yield* f.api;
      const candidates = yield* api.listCandidates!({
        cwd: target.cwd,
        host: target.host,
        scope: target.scope,
      });
      expect(candidates.labels.map((label) => label.name)).toEqual(labels.slice(0, 100));
      expect(candidates.assignees).toEqual([]);
      expect(candidates.issueTypes).toEqual([{ id: "task", name: "Task" }]);
      expect(candidates.truncated).toBe(true);
      expect(candidates.states).toMatchObject([
        { id: "2", name: "Review", workflowCategory: "started" },
      ]);
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

it.effect("loads embedded conversation, history and remote links with four detail requests", () =>
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
            startAt: 0,
            total: 1,
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
              total: 1,
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
    expect(f.calls).toHaveLength(4);
    expect(f.calls[0]?.url).toContain("expand=changelog");
    expect(result.commentsCursor).toBeNull();
    expect(result.events[0]).toMatchObject({ kind: "renamed", detail: "Task" });
    expect(result.comments[0]?.body).toBe("body");
  }),
);

it.effect("loads true newest comments when Jira embeds an unqualified partial page", () =>
  Effect.gen(function* () {
    const nativeComments = Array.from({ length: 150 }, (_, index) => ({
      id: String(index + 1),
      author: user,
      body: issue.fields.description,
      created: `2026-10-14T${10 + Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}:00Z`,
      updated: issue.fields.updated,
    }));
    for (const [embeddedCount, embeddedStartAt] of [
      [100, 0],
      [20, 0],
      [100, 50],
    ] as const) {
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
            changelog: { startAt: 0, total: 0, histories: [] },
            fields: {
              ...issue.fields,
              comment: {
                startAt: embeddedStartAt,
                total: 150,
                comments: nativeComments.slice(0, embeddedCount),
              },
            },
          },
        };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(f.calls).toHaveLength(5);
      expect(JSON.parse(result.commentsCursor!).position).toBe(50);
      const loaded = [...result.comments];
      let cursor = result.commentsCursor;
      while (cursor !== null) {
        const page = yield* api.getComments({ ...target, cursor });
        const ids = page.comments.map((comment) => Number(comment.id));
        expect(ids).toEqual(ids.toSorted((a, b) => b - a));
        loaded.push(...page.comments);
        cursor = page.nextCursor;
      }
      expect(offsets).toEqual([0, 50, 100]);
      expect(loaded.map((comment) => comment.id)).toEqual(
        nativeComments.toReversed().map((comment) => comment.id),
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
            changelog: { startAt: 0, total: 0, histories: [] },
            fields: { ...issue.fields, comment },
          },
        };
      });
      const api = yield* f.api;
      const result = yield* api.getIssue(target);
      expect(result.comments).toHaveLength(comment.total);
      expect(result.commentsCursor).toBeNull();
      expect(f.calls).toHaveLength(4);
    }
  }),
);

it.effect("starts comment paging with the true latest comments in descending order", () =>
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
    const page = yield* api.getComments(target);
    expect(page.comments.map((comment) => comment.id)).toEqual(["4", "3", "2"]);
    expect(JSON.parse(page.nextCursor!).position).toBe(3);
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

it.effect("loads only the true tail of bounded native history", () =>
  Effect.gen(function* () {
    for (const embedded of [true, false]) {
      const histories = Array.from({ length: 123 }, (_, index) => ({
        id: String(index + 1),
        created: issue.fields.created,
        items: [{ field: "summary", toString: String(index + 1) }],
      }));
      const f = fakeJira((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/myself")) return { body: user };
        if (url.pathname.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (url.pathname.endsWith("/changelog")) {
          const startAt = Number(url.searchParams.get("startAt"));
          const limit = Number(url.searchParams.get("maxResults"));
          return {
            body: {
              startAt,
              total: histories.length,
              isLast: startAt + limit >= histories.length,
              values: histories.slice(startAt, startAt + limit),
            },
          };
        }
        return {
          body: {
            ...issue,
            fields: { ...issue.fields, comment: { total: 0, comments: [] } },
            ...(embedded
              ? {
                  changelog: {
                    startAt: 0,
                    total: histories.length,
                    histories: histories.slice(0, 100),
                  },
                }
              : {}),
          },
        };
      });
      const result = yield* (yield* f.api).getIssue(target);
      expect(result.events.map((event) => event.detail)).toEqual(
        histories
          .slice(-50)
          .toReversed()
          .map((row) => row.id),
      );
      expect(result.historyTruncated).toBe(true);
      const reads = f.calls.filter(({ url }) => url.includes("/changelog?"));
      expect(reads).toHaveLength(embedded ? 1 : 2);
      expect(reads.at(-1)?.url).toContain("startAt=73&maxResults=50");
      expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
    }
  }),
);

it.effect("lets Jira token permissions decide edits without reading a viewer", () =>
  Effect.gen(function* () {
    let allowed = true;
    let applied = 0;
    const f = fakeJira((request) => {
      if (request.method === "PUT") {
        if (!allowed) return { status: 403, body: {} };
        applied++;
        return {
          body: {
            id: "c1",
            body: issue.fields.description,
            author: user,
            created: issue.fields.created,
            updated: issue.fields.updated,
          },
        };
      }
      if (request.url.endsWith("/comment/c1"))
        return {
          body: {
            id: "c1",
            body: issue.fields.description,
            author: user,
            created: issue.fields.created,
            updated: issue.fields.updated,
          },
        };
      return { body: issue };
    });
    const api = yield* f.api;
    yield* api.editComment!({ ...target, commentId: "c1", body: "new" });
    expect(f.calls).toHaveLength(3);
    allowed = false;
    yield* api.editComment!({
      ...target,
      viewer: "spoofed",
      commentId: "c1",
      body: "forbidden",
    }).pipe(Effect.flip);
    expect(applied).toBe(1);
    expect(
      f.calls.some(
        (request) => request.url.includes("/myself") || request.url.includes("/mypermissions"),
      ),
    ).toBe(false);
  }),
);

it.effect.each([200, 403])(
  "safely edits an exact older comment with native PUT status %s",
  (status) =>
    Effect.gen(function* () {
      const comment = {
        id: "9001",
        body: issue.fields.description,
        author: user,
        created: issue.fields.created,
        updated: issue.fields.updated,
      };
      const f = fakeJira((request) => {
        if (request.method === "PUT") return { status, body: comment };
        return { body: request.url.endsWith("/comment/9001") ? comment : issue };
      });
      const api = yield* f.api;
      const result = yield* Effect.result(
        api.editComment!({
          ...target,
          commentId: "9001",
          body: "changed",
          viewer: "spoofed",
        }),
      );
      expect(result._tag).toBe(status === 200 ? "Success" : "Failure");
      if (result._tag === "Failure") expect(result.failure.detail).toContain("403");
      expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
      expect(f.calls.map(({ url }) => new URL(url).pathname)).toEqual([
        "/rest/api/3/issue/ENG-1",
        "/rest/api/3/issue/ENG-1/comment/9001",
        "/rest/api/3/issue/ENG-1/comment/9001",
      ]);
      expect(body(f.calls[2])).toEqual({
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }],
        },
      });
    }),
);

const richCommentBody = {
  type: "doc",
  version: 1,
  content: [
    { type: "paragraph", content: [{ type: "text", text: "rich", marks: [{ type: "strong" }] }] },
  ],
};

it.effect.each([
  richCommentBody,
  {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: { id: "native-account", text: "@Ada" } }],
      },
    ],
  },
  {
    type: "doc",
    version: 1,
    content: [
      {
        type: "taskList",
        attrs: { localId: "list" },
        content: [{ type: "taskItem", attrs: { localId: "task", state: "TODO" } }],
      },
    ],
  },
  undefined,
  { type: "doc", version: 1, content: [{ type: "paragraph", content: "invalid" }] },
])("refuses unsafe native comment replacement before PUT: %j", (currentBody) =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/comment/")
        ? {
            id: "9001",
            body: currentBody,
            created: issue.fields.created,
            updated: issue.fields.updated,
          }
        : issue,
    }));
    const api = yield* f.api;
    expect(
      (yield* api.editComment!({ ...target, commentId: "9001", body: "changed" }).pipe(Effect.flip))
        .reason,
    ).toBe("failed");
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(f.calls[1]?.url).toBe(
      "https://example.atlassian.net/rest/api/3/issue/ENG-1/comment/9001",
    );
  }),
);

it.effect.each([403, 404])("preserves native comment GET denial %s without a write", (status) =>
  Effect.gen(function* () {
    const f = fakeJira((request) =>
      request.url.includes("/comment/") ? { status } : { body: issue },
    );
    const api = yield* f.api;
    const error = yield* api.editComment!({ ...target, commentId: "9001", body: "changed" }).pipe(
      Effect.flip,
    );
    expect(error.detail).toContain(String(status));
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
  }),
);

it.effect("refuses a foreign project before reading or editing its comment", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: { ...issue, fields: { ...issue.fields, project: { id: "99", key: "OTHER" } } },
    }));
    const api = yield* f.api;
    expect(
      (yield* api.editComment!({ ...target, commentId: "9001", body: "changed" }).pipe(Effect.flip))
        .reason,
    ).toBe("not-found");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe("GET");
  }),
);

it.effect(
  "exposes native rich editing for comment pages without extra viewer or comment reads",
  () =>
    Effect.gen(function* () {
      const f = fakeJira((request) => {
        if (request.url.includes("/mypermissions?"))
          return { body: { permissions: { EDIT_ALL_COMMENTS: { havePermission: true } } } };
        if (new URL(request.url).pathname.endsWith("/comment"))
          return {
            body: {
              startAt: 0,
              total: 2,
              comments: [issue.fields.description, richCommentBody].map((body, index) => ({
                id: String(9000 + index),
                body,
                author: user,
                created: issue.fields.created,
                updated: issue.fields.updated,
              })),
            },
          };
        return { body: issue };
      });
      const api = yield* f.api;
      const page = yield* api.getComments({ ...target, viewer: user.accountId });
      expect(page.comments).toEqual([
        expect.objectContaining({ id: "9000", body: "body", canEdit: true }),
        expect.objectContaining({
          id: "9001",
          body: "rich",
          canEdit: true,
          richBody: expect.objectContaining({ format: "adf" }),
        }),
      ]);
      expect(f.calls).toHaveLength(3);
      expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
      expect(f.calls.some(({ url }) => url.includes("/myself") || url.includes("/comment/"))).toBe(
        false,
      );
    }),
);

it.effect("adds edit flags to comment pages without a viewer request", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/mypermissions"))
        return { body: { permissions: { EDIT_OWN_COMMENTS: { havePermission: true } } } };
      if (url.pathname.endsWith("/comment"))
        return {
          body: {
            startAt: 0,
            total: 1,
            comments: [
              {
                id: "c1",
                body: issue.fields.description,
                author: user,
                created: issue.fields.created,
                updated: issue.fields.updated,
              },
            ],
          },
        };
      return { body: issue };
    });
    const api = yield* f.api;
    const page = yield* api.getComments({ ...target, viewer: user.accountId });
    expect(page.comments[0]).toMatchObject({ canEdit: true, editedAt: "2026-10-14T11:00:00.000Z" });
    expect(f.calls.some((request) => request.url.includes("/myself"))).toBe(false);
  }),
);

it.effect("pages history and rejects inconsistent offsets", () =>
  Effect.gen(function* () {
    let inconsistent = false;
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      const startAt = Number(url.searchParams.get("startAt"));
      return {
        body: url.pathname.endsWith("/changelog")
          ? {
              startAt: inconsistent ? 0 : startAt,
              total: 2,
              isLast: startAt === 1,
              values: [
                {
                  id: String(startAt + 1),
                  author: user,
                  created: issue.fields.created,
                  items: [{ field: "summary", fromString: "Old", toString: "New" }],
                },
              ],
            }
          : issue,
      };
    });
    const api = yield* f.api;
    const first = yield* api.getHistory!({ ...target, order: "asc", limit: 1 });
    expect(first.items).toMatchObject([{ kind: "renamed", detail: "New" }]);
    expect(first.nextCursor).not.toBeNull();
    inconsistent = true;
    expect(
      (yield* api.getHistory!({
        ...target,
        order: "asc",
        cursor: first.nextCursor!,
        limit: 1,
      }).pipe(Effect.flip)).reason,
    ).toBe("failed");
  }),
);

it.effect("reads hierarchy and changes parents while protecting subtasks", () =>
  Effect.gen(function* () {
    let subtask = false;
    const current = () => ({
      ...issue,
      fields: {
        ...issue.fields,
        parent: { key: "ENG-2" },
        issuetype: { id: "type-1", name: "Task", subtask },
      },
    });
    const parent = { ...issue, key: "ENG-2" };
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (request.method === "PUT") return { status: 204 };
      if (url.pathname.endsWith("/search/jql"))
        return {
          body: {
            issues: [
              { ...issue, key: "ENG-3", fields: { ...issue.fields, parent: { key: "ENG-1" } } },
            ],
            isLast: false,
            nextPageToken: "next",
          },
        };
      return { body: url.pathname.endsWith("/ENG-2") ? parent : current() };
    });
    const api = yield* f.api;
    expect(yield* api.getHierarchy!({ ...target, limit: 1 })).toMatchObject({
      parent: { key: "ENG-2" },
      children: { items: [{ key: "ENG-3" }], nextCursor: "next" },
    });
    yield* api.setParent!({ ...target, parentKey: "ENG-2" });
    yield* api.setParent!({ ...target, parentKey: null });
    subtask = true;
    yield* api.setParent!({ ...target, parentKey: null }).pipe(Effect.flip);
    yield* api.setParent!({ ...target, parentKey: "ENG-1" }).pipe(Effect.flip);
    expect(f.calls.filter((request) => request.method === "PUT").map(body)).toEqual([
      { fields: { parent: { key: "ENG-2" } } },
      { update: { parent: [{ set: { none: true } }] } },
    ]);
  }),
);

it.effect("keeps native category filters and sort order in Jira JQL", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { issues: [issue], isLast: true } }));
    const api = yield* f.api;
    yield* api.listIssues({
      ...target,
      state: "open",
      stateCategories: ["started", "completed", "canceled"],
      sort: "created",
      order: "asc",
      involvement: "all",
      viewer: user.accountId,
      limit: 1,
    });
    expect(body(f.calls[0])).toMatchObject({
      jql: 'project = "ENG" AND statusCategory IN ("indeterminate", "done") ORDER BY created ASC',
    });
    yield* api
      .listIssues({
        ...target,
        state: "all",
        sort: "comments",
        involvement: "all",
        viewer: user.accountId,
        limit: 1,
      })
      .pipe(Effect.flip);
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect("pages label candidates and the bounded Jira assignee search", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/search/jql")
        ? { issues: [issue], isLast: false, nextPageToken: "next" }
        : [user],
    }));
    const api = yield* f.api;
    expect(yield* api.listLabelCandidates!({ ...target, limit: 1 })).toMatchObject({
      items: [{ name: "bug" }],
      nextCursor: "next",
    });
    expect(
      yield* api.listAssigneeCandidates!({ ...target, limit: 10, cursor: "990" }),
    ).toMatchObject({ items: [{ id: user.accountId }], nextCursor: null, truncated: true });
    yield* api.listAssigneeCandidates!({ ...target, cursor: "1000" }).pipe(Effect.flip);
    expect(f.calls).toHaveLength(2);
  }),
);

it.effect("continues filtered Jira assignee windows after short and empty results", () =>
  Effect.gen(function* () {
    const windows = [
      [user],
      [],
      Array.from({ length: 100 }, (_, index) => ({ ...user, accountId: `later-${index}` })),
    ];
    const f = fakeJira((request) => ({
      body: windows[Number(new URL(request.url).searchParams.get("startAt")) / 100] ?? [],
    }));
    const api = yield* f.api;
    let cursor: string | undefined;
    for (const [index, users] of windows.entries()) {
      const page = yield* api.listAssigneeCandidates!({ ...target, limit: 100, cursor });
      expect(page.items.map(({ id }) => id)).toEqual(users.map(({ accountId }) => accountId));
      expect(page.nextCursor).toBe(String((index + 1) * 100));
      expect(page.truncated).toBeUndefined();
      expect(f.calls).toHaveLength(index + 1);
      cursor = page.nextCursor!;
    }
    expect(yield* api.listAssigneeCandidates!({ ...target, limit: 100, cursor: "900" })).toEqual({
      items: [],
      nextCursor: null,
      truncated: true,
    });
    yield* api.listAssigneeCandidates!({ ...target, cursor: "1000" }).pipe(Effect.flip);
    expect(f.calls.map(({ url }) => new URL(url).search)).toEqual([
      "?project=ENG&startAt=0&maxResults=100",
      "?project=ENG&startAt=100&maxResults=100",
      "?project=ENG&startAt=200&maxResults=100",
      "?project=ENG&startAt=900&maxResults=100",
    ]);
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  }),
);

it.effect("preserves changelog fields outside the old common event kinds", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/changelog?")
        ? {
            startAt: 0,
            total: 1,
            isLast: true,
            values: [
              {
                id: "h1",
                author: user,
                created: issue.fields.created,
                items: [{ field: "priority", fromString: "Low", toString: "High" }],
              },
            ],
          }
        : issue,
    }));
    const api = yield* f.api;
    expect(yield* api.getHistory!({ ...target, limit: 1 })).toMatchObject({
      items: [{ kind: "updated", detail: "priority: Low → High" }],
      nextCursor: null,
    });
  }),
);

it.effect.each([true, false])(
  "creates a cross-project base parent only when native metadata allows parent: %s",
  (parentAllowed) =>
    Effect.gen(function* () {
      const f = fakeJira((request) => {
        if (request.method === "POST") return { status: 201, body: { key: "ENG-2" } };
        if (request.url.includes("/issuetypes/task?"))
          return {
            body: {
              startAt: 0,
              total: parentAllowed ? 2 : 1,
              fields: [
                { fieldId: "summary", required: true },
                ...(parentAllowed ? [{ fieldId: "parent", required: false }] : []),
              ],
            },
          };
        if (request.url.includes("/issuetypes?"))
          return {
            body: {
              startAt: 0,
              total: 1,
              issueTypes: [{ id: "task", name: "Task", subtask: false }],
            },
          };
        return {
          body: {
            ...issue,
            key: "OPS-8",
            fields: { ...issue.fields, project: { id: "30", key: "OPS" } },
          },
        };
      });
      const result = yield* (yield* f.api).create!({
        ...target,
        title: "Child",
        body: "",
        labels: [],
        assignees: [],
        issueType: "task",
        parentKey: "OPS-8",
      }).pipe(Effect.result);
      if (parentAllowed) {
        expect(result._tag).toBe("Success");
        expect(body(f.calls.at(-1))).toMatchObject({
          fields: { project: { key: "ENG" }, parent: { key: "OPS-8" } },
        });
        expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET", "POST"]);
      } else {
        expect(result._tag).toBe("Failure");
        expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
      }
    }),
);

it.effect("creates Jira subtasks with a checked parent and keeps their type available", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/issue"))
        return { body: { key: "ENG-2" } };
      if (request.url.includes("/issuetypes/subtask?"))
        return {
          body: {
            startAt: 0,
            total: 3,
            fields: [
              { fieldId: "summary", required: true },
              { fieldId: "issuetype", required: true },
              { fieldId: "parent", required: true },
            ],
          },
        };
      if (request.url.includes("/issuetypes?"))
        return {
          body: {
            startAt: 0,
            total: 1,
            issueTypes: [{ id: "subtask", name: "Subtask", subtask: true }],
          },
        };
      if (request.url.includes("/issue/OPS-1"))
        return {
          body: {
            ...issue,
            key: "OPS-1",
            fields: { ...issue.fields, project: { id: "30", key: "OPS" } },
          },
        };
      return { body: issue };
    });
    const api = yield* f.api;
    const input = {
      ...target,
      title: "Child",
      body: "",
      labels: [],
      assignees: [],
      issueType: "subtask",
      parentKey: "ENG-1",
    };
    expect(yield* api.create!(input)).toMatchObject({ key: "ENG-2", parentLinked: true });
    expect(body(f.calls.find((request) => request.method === "POST"))).toMatchObject({
      fields: { parent: { key: "ENG-1" }, issuetype: { id: "subtask" }, summary: "Child" },
    });
    expect(yield* api.create!({ ...input, parentKey: "OPS-1" }).pipe(Effect.flip)).toMatchObject({
      operation: "getIssue",
      reason: "not-found",
    });
    expect(f.calls.filter((request) => request.method === "POST")).toHaveLength(1);
  }),
);

it.effect.each([[], ["canceled"], ["backlog"], ["canceled", "backlog"]] as const)(
  "returns no Jira rows or requests for unsupported native categories: %j",
  (stateCategories) =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({ body: { issues: [issue], isLast: true } }));
      const api = yield* f.api;
      expect(
        yield* api.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          viewer: user.accountId,
          stateCategories,
          limit: 1,
          cursor: "old-page",
        }),
      ).toEqual({ items: [], nextCursor: null });
      expect(f.calls).toHaveLength(0);
    }),
);

it.effect.each([
  { stateCategories: ["canceled", "completed"], native: "done", workflowCategory: "completed" },
  { stateCategories: ["backlog", "unstarted"], native: "new", workflowCategory: "unstarted" },
  {
    stateCategories: ["backlog", "canceled", "started"],
    native: "indeterminate",
    workflowCategory: "started",
  },
] as const)(
  "keeps only supported mixed Jira categories and native cursors: %j",
  ({ stateCategories, native, workflowCategory }) =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({
        body: {
          issues: [
            {
              ...issue,
              fields: {
                ...issue.fields,
                status: {
                  ...issue.fields.status,
                  statusCategory: { key: native },
                },
              },
            },
          ],
          isLast: false,
          nextPageToken: "next-native",
        },
      }));
      const api = yield* f.api;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: user.accountId,
        stateCategories,
        limit: 1,
        cursor: "previous-native",
      });
      expect(page.items.map(({ state }) => state.workflowCategory)).toEqual([workflowCategory]);
      expect(page.nextCursor).toBe("next-native");
      expect(f.calls).toHaveLength(1);
      expect(body(f.calls[0])).toMatchObject({
        jql: `project = "ENG" AND statusCategory IN ("${native}") ORDER BY updated DESC`,
        nextPageToken: "previous-native",
      });
    }),
);

it.effect("validates Jira project scope before an empty category result and on mixed rows", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        issues: [
          {
            ...issue,
            fields: { ...issue.fields, project: { id: "21", key: "OPS" } },
          },
        ],
        isLast: true,
      },
    }));
    const api = yield* f.api;
    const input = {
      ...target,
      state: "all" as const,
      involvement: "all" as const,
      viewer: user.accountId,
      limit: 1,
    };
    expect(
      (yield* api.listIssues({ ...input, scope: "", stateCategories: [] }).pipe(Effect.flip))
        .reason,
    ).toBe("failed");
    expect(f.calls).toHaveLength(0);
    expect(
      (yield* api
        .listIssues({ ...input, stateCategories: ["canceled", "started"] })
        .pipe(Effect.flip)).reason,
    ).toBe("failed");
    expect(f.calls).toHaveLength(1);
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
    for (const { status, description } of [
      { status: 204, description: issue.fields.description },
      { status: 403, description: issue.fields.description },
      { status: 204, description: null },
    ]) {
      const f = fakeJira((request) =>
        request.method === "GET"
          ? { body: { ...issue, fields: { ...issue.fields, description } } }
          : { status },
      );
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

it.effect.each(["asc", "desc"] as const)(
  "reads true Jira comment and history windows in %s order",
  (order) =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 123 }, (_, index) => ({
        id: String(index + 1),
        created: `2026-10-${String(14 + Math.floor(index / 60)).padStart(2, "0")}T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        updated: issue.fields.updated,
        body: issue.fields.description,
        items: [{ field: "summary", toString: String(index + 1) }],
      }));
      const f = fakeJira((request) => {
        const url = new URL(request.url);
        const startAt = Number(url.searchParams.get("startAt"));
        const limit = Number(url.searchParams.get("maxResults"));
        if (url.pathname.endsWith("/comment")) {
          expect(url.searchParams.get("orderBy")).toBe(order === "desc" ? "-created" : "created");
          const sorted = order === "desc" ? rows.toReversed() : rows;
          return {
            body: { startAt, total: rows.length, comments: sorted.slice(startAt, startAt + limit) },
          };
        }
        if (url.pathname.endsWith("/changelog"))
          return {
            body: {
              startAt,
              total: rows.length,
              isLast: startAt + limit >= rows.length,
              values: rows.slice(startAt, startAt + limit),
            },
          };
        return { body: issue };
      });
      const api = yield* f.api;
      const selected = { ...target, connectionId: "account-a", order };
      for (const kind of ["comments", "history"] as const) {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const before = f.calls.length;
          const page =
            kind === "comments"
              ? yield* api.getComments({ ...selected, ...(cursor === undefined ? {} : { cursor }) })
              : yield* api.getHistory!({
                  ...selected,
                  limit: 50,
                  ...(cursor === undefined ? {} : { cursor }),
                });
          expect(f.calls.length - before).toBeLessThanOrEqual(
            cursor === undefined && kind === "history" && order === "desc" ? 3 : 2,
          );
          ids.push(
            ...("comments" in page
              ? page.comments.map((row) => row.id)
              : page.items.map((row) => row.id.split(":")[0]!)),
          );
          cursor = page.nextCursor ?? undefined;
          if (cursor !== undefined) {
            for (const changed of [
              { connectionId: "account-b" },
              { order: order === "desc" ? ("asc" as const) : ("desc" as const) },
              { cwd: "/other" },
              { scope: "OTHER" },
              { key: "ENG-2" },
              { host: "other.atlassian.net" },
            ]) {
              const calls = f.calls.length;
              const bad = { ...selected, ...changed, cursor };
              if (kind === "comments") yield* api.getComments(bad).pipe(Effect.flip);
              else yield* api.getHistory!(bad).pipe(Effect.flip);
              expect(f.calls).toHaveLength(calls);
            }
            const parsed: Record<string, unknown> = JSON.parse(cursor);
            for (const position of [-1, 0, Number(parsed.total)]) {
              const before = f.calls.length;
              const bad = { ...selected, cursor: JSON.stringify({ ...parsed, position }) };
              if (kind === "comments") yield* api.getComments(bad).pipe(Effect.flip);
              else yield* api.getHistory!(bad).pipe(Effect.flip);
              expect(f.calls).toHaveLength(before);
            }
          }
        } while (cursor !== undefined);
        expect(ids).toEqual((order === "desc" ? rows.toReversed() : rows).map((row) => row.id));
        expect(new Set(ids).size).toBe(123);
      }
      for (const cursor of ["0", "50", "{}", "null", "[]"]) {
        const before = f.calls.length;
        yield* api.getComments({ ...selected, cursor }).pipe(Effect.flip);
        yield* api.getHistory!({ ...selected, cursor }).pipe(Effect.flip);
        expect(f.calls).toHaveLength(before);
      }
    }),
);

it.effect.each([
  { startAt: 1, total: 2, ids: [2] },
  { startAt: 0, total: 0, ids: [2] },
  { startAt: 0, total: 2, ids: [] },
  { startAt: 0, total: 2, ids: [2, 2] },
  { startAt: 0, total: 2, ids: [1, 2] },
])("refuses inconsistent Jira native comment pages: %j", ({ startAt, total, ids }) =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/comment?")
        ? {
            startAt,
            total,
            comments: ids.map((id) => ({
              id: String(id),
              body: issue.fields.description,
              created: `2026-10-14T0${id}:00:00Z`,
              updated: issue.fields.updated,
            })),
          }
        : issue,
    }));
    const error = yield* (yield* f.api).getComments(target).pipe(Effect.flip);
    expect(error.reason).toBe("failed");
    expect(f.calls).toHaveLength(2);
  }),
);

it.effect("rejects contradictory Jira tail metadata before a tail read", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.includes("/changelog?")
        ? {
            startAt: 0,
            total: 123,
            isLast: true,
            values: [{ id: "1", created: issue.fields.created, items: [] }],
          }
        : issue,
    }));
    yield* (yield* f.api).getHistory!(target).pipe(Effect.flip);
    expect(f.calls).toHaveLength(2);
  }),
);

it.effect(
  "orders a complete Cloud expanded changelog by time before choosing its newest window",
  () =>
    Effect.gen(function* () {
      const histories = Array.from({ length: 80 }, (_, index) => ({
        id: String(index + 1),
        created:
          "2026-10-" +
          String(14 + Math.floor(index / 60)).padStart(2, "0") +
          "T00:" +
          String(index % 60).padStart(2, "0") +
          ":00Z",
        items: [{ field: "summary", toString: String(index + 1) }],
      }));
      const f = fakeJira((request) => {
        if (request.url.endsWith("/myself")) return { body: user };
        if (request.url.includes("/mypermissions?")) return { body: { permissions: {} } };
        return {
          body: {
            ...issue,
            changelog: { startAt: 0, total: histories.length, histories: histories.toReversed() },
            fields: { ...issue.fields, comment: { total: 0, comments: [] } },
          },
        };
      });
      const result = yield* (yield* f.api).getIssue(target);
      expect(result.events.map((row) => row.detail)).toEqual(
        histories
          .slice(-50)
          .toReversed()
          .map((row) => row.id),
      );
      expect(result.historyTruncated).toBe(true);
      expect(f.calls).toHaveLength(4);
    }),
);

it.effect.each(["asc", "desc"] as const)(
  "keeps Jira Data Center history and wiki comment order in %s",
  (order) =>
    Effect.gen(function* () {
      const histories = Array.from({ length: 123 }, (_, index) => ({
        id: String(index + 1),
        created: issue.fields.created,
        items: [{ field: "summary", toString: String(index + 1) }],
      }));
      const nativeUser = { key: "native-account", name: "ada" };
      const dcIssue = {
        ...issue,
        changelog: { startAt: 0, total: histories.length, histories },
        fields: {
          ...issue.fields,
          creator: nativeUser,
          assignee: nativeUser,
          description: "wiki",
          comment: { startAt: 0, total: 0, comments: [] },
        },
      };
      const f = fakeJira(
        (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith("/myself")) return { body: nativeUser };
          if (url.pathname.endsWith("/mypermissions"))
            return { body: { permissions: { EDIT_OWN_COMMENTS: { havePermission: true } } } };
          if (url.pathname.endsWith("/comment")) {
            const startAt = Number(url.searchParams.get("startAt"));
            const sorted = order === "desc" ? histories.toReversed() : histories;
            expect(url.searchParams.get("orderBy")).toBe(order === "desc" ? "-created" : "created");
            return {
              body: {
                startAt,
                total: histories.length,
                comments: sorted.slice(startAt, startAt + 50).map((row) => ({
                  ...row,
                  updated: row.created,
                  body: "h1. wiki",
                  author: nativeUser,
                })),
              },
            };
          }
          return { body: dcIssue };
        },
        JSON.stringify({ site: target.host, deployment: "data-center", token: "fake-pat" }),
      );
      const api = yield* f.api;
      const detail = yield* api.getIssue(target);
      expect(detail.events.map((row) => row.detail)).toEqual(
        histories
          .slice(-50)
          .toReversed()
          .map((row) => row.id),
      );
      expect(detail.historyTruncated).toBe(true);
      const selected = { ...target, order };
      const loaded: string[] = [];
      let cursor: string | undefined;
      do {
        const before = f.calls.length;
        const page = yield* api.getHistory!({
          ...selected,
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(f.calls.length - before).toBe(cursor === undefined && order === "desc" ? 1 : 2);
        loaded.push(...page.items.map((row) => row.detail!));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(loaded).toEqual(
        (order === "desc" ? histories.toReversed() : histories).map((row) => row.id),
      );
      const page = yield* api.getComments({ ...selected, viewer: "native-account" });
      expect(page.comments[0]).toMatchObject({
        id: order === "desc" ? "123" : "1",
        body: "h1. wiki",
        richBody: { format: "jira-wiki", document: "h1. wiki" },
        canEdit: true,
      });
      expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
      expect(f.calls.every(({ url }) => !url.includes("/rest/api/3/"))).toBe(true);
    }),
);
