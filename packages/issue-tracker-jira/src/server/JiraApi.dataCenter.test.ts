import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  ConnectionId,
  IssueTrackerHost,
} from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";
import { JiraIssue, JiraUser, textToAdf } from "./jiraJson.ts";

const site = "https://jira.example.test:8443/Team/Jira";
const host = "jira.example.test:8443/Team/Jira";
const packed = JSON.stringify({ deployment: "data-center", site, token: "fake-pat" });
const user = { key: "JIRAUSER101", name: "ada.renamed", displayName: "Ada" };
const decodeSearchRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    jql: Schema.String,
    startAt: Schema.Int,
    fields: Schema.Array(Schema.String),
  }),
);
const issue = {
  id: "1",
  key: "ENG-1",
  fields: {
    project: { id: "20", key: "ENG" },
    summary: "Native task",
    description: "*bold* and !image.png|width=200! [link|https://example.test]",
    created: "2026-10-15T10:00:00Z",
    updated: "2026-10-15T11:00:00Z",
    creator: user,
    assignee: user,
    status: { id: "2", name: "Review", statusCategory: { key: "indeterminate" } },
  },
};

function fakeJira(
  reply: (request: HttpClientRequest.HttpClientRequest) => {
    readonly body?: unknown;
    readonly status?: number;
    readonly headers?: Record<string, string>;
  },
  credentials: Record<string, string> = { default: packed },
) {
  const calls: HttpClientRequest.HttpClientRequest[] = [];
  const transport = HttpClient.make((request) => {
    calls.push(request);
    const response = reply(request);
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
  return {
    calls,
    api: JiraApi.make.pipe(
      Effect.provideService(HttpClient.HttpClient, transport),
      Effect.provideService(
        IssueTrackerHost,
        IssueTrackerHost.of({
          credentials: {
            get: (_kind, selected) =>
              Effect.map(ConnectionId, (current) =>
                Option.fromNullishOr(credentials[selected ?? current ?? "default"]),
              ),
          },
        }),
      ),
      Effect.provide(SourceControlRateLimit.layer),
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  };
}

function body(request: HttpClientRequest.HttpClientRequest | undefined): unknown {
  if (request?.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
  return JSON.parse(new TextDecoder().decode(request.body.body));
}

function epicFixture(
  override?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => { body?: unknown; status?: number } | undefined,
) {
  let parent: string | null = "ENG-9";
  const source = (key: string) => ({
    ...issue,
    key,
    changelog: { startAt: 0, total: 0, histories: [] },
    fields: {
      ...issue.fields,
      issuetype: {
        id: key === "ENG-2" ? "native-epic" : "native-base",
        name: "Renamed type",
        subtask: false,
      },
      epic: key === "ENG-1" && parent !== null ? { id: 9, key: parent } : null,
      comment: { total: 0, comments: [] },
    },
  });
  const f = fakeJira((request) => {
    const custom = override?.(request);
    if (custom !== undefined) return custom;
    const url = new URL(request.url);
    if (request.method === "POST" && /\/agile\/1.0\/epic\/[^/]+\/issue$/.test(url.pathname)) {
      parent = url.pathname.includes("/none/") ? null : "ENG-2";
      return { status: 204 };
    }
    if (url.pathname.endsWith("/mypermissions"))
      return { body: { permissions: { EDIT_ISSUES: { havePermission: true } } } };
    if (url.pathname.endsWith("/myself")) return { body: user };
    if (url.pathname.endsWith("/remotelink")) return { body: [] };
    if (url.pathname.endsWith("/search")) {
      const search = decodeSearchRequest(body(request));
      return {
        body: {
          startAt: search.startAt,
          total: search.jql.includes('"ENG-2"') ? 1 : 0,
          issues: search.jql.includes('"ENG-2"')
            ? [
                {
                  ...source("ENG-4"),
                  fields: {
                    ...source("ENG-4").fields,
                    parent: { key: "ENG-2" },
                    issuetype: { id: "sub", name: "Sub", subtask: true },
                  },
                },
              ]
            : [],
        },
      };
    }
    if (/\/agile\/1.0\/epic\/ENG-2\/issue$/.test(url.pathname)) {
      const startAt = Number(url.searchParams.get("startAt"));
      const maxResults = Number(url.searchParams.get("maxResults"));
      const children = ["ENG-1", "ENG-3"].map((key) => ({
        ...source(key),
        fields: { ...source(key).fields, epic: { id: 2, key: "ENG-2" } },
      }));
      return { body: { startAt, total: 2, issues: children.slice(startAt, startAt + maxResults) } };
    }
    if (/\/agile\/1.0\/epic\//.test(url.pathname)) {
      if (url.pathname.endsWith("/ENG-2") || url.pathname.endsWith("/ENG-9"))
        return {
          body: {
            id: 2,
            key: url.pathname.endsWith("/ENG-9") ? "ENG-9" : "ENG-2",
            name: "Renamed epic",
            summary: "Epic",
          },
        };
      return { status: 404, body: {} };
    }
    const key = url.pathname.split("/").at(-1)!;
    return { body: source(key) };
  });
  return {
    ...f,
    source,
    tracker: f.api.pipe(
      Effect.flatMap((api) =>
        JiraIssueTracker.make.pipe(Effect.provideService(JiraApi.JiraApi, api)),
      ),
    ),
  };
}

it.effect.each(["cloud", "data-center"] as const)(
  "keeps source scope and selected credentials for same-instance parent changes on %s",
  (deployment) =>
    Effect.gen(function* () {
      const cloud = deployment === "cloud";
      const selectedHost = cloud ? "selected.atlassian.net" : host;
      const selectedSite = "https://" + selectedHost;
      let wrongSource = false;
      let parentStatus = 200;
      let writeStatus = 204;
      const f = fakeJira(
        (request) => {
          const url = new URL(request.url);
          const key = url.pathname.split("/").at(-1)!;
          if (request.method !== "GET") return { status: writeStatus };
          if (key === "OPS-8" && parentStatus !== 200) return { status: parentStatus };
          if (url.pathname.includes("/agile/1.0/epic/"))
            return key === "ENG-1" ? { status: 404 } : { body: { key } };
          return {
            body: {
              ...issue,
              key,
              fields: {
                ...issue.fields,
                creator: cloud ? { accountId: user.key } : user,
                assignee: cloud ? { accountId: user.key } : user,
                project: {
                  id: key.startsWith("OPS-") ? "30" : "20",
                  key: wrongSource && key === "ENG-1" ? "OTHER" : key.split("-")[0],
                },
                issuetype: {
                  id: key === "ENG-1" ? "base" : "epic",
                  name: "Native",
                  subtask: false,
                },
                epic: null,
              },
            },
          };
        },
        {
          default: packed,
          selected: JSON.stringify({
            deployment,
            site: selectedSite,
            email: "selected@example.test",
            token: "fake-selected",
          }),
        },
      );
      const tracker = yield* f.api.pipe(
        Effect.flatMap((api) =>
          JiraIssueTracker.make.pipe(Effect.provideService(JiraApi.JiraApi, api)),
        ),
      );
      const target = { cwd: "/tmp", host: selectedHost, scope: "ENG", key: "ENG-1" };
      for (const parentKey of ["OPS-8", "ENG-8", null]) {
        f.calls.length = 0;
        yield* tracker.setParent!({ ...target, parentKey }).pipe(
          Effect.provideService(ConnectionId, "selected"),
        );
        expect(f.calls.map(({ method }) => method)).toEqual([
          ...Array.from(
            { length: cloud ? (parentKey === null ? 1 : 2) : parentKey === null ? 3 : 5 },
            () => "GET",
          ),
          cloud ? "PUT" : "POST",
        ]);
        expect(f.calls.every((r) => r.url.startsWith(selectedSite + "/rest/"))).toBe(true);
        expect(
          f.calls.every(
            (r) =>
              r.headers.authorization ===
              (cloud
                ? "Basic " + btoa("selected@example.test:fake-selected")
                : "Bearer fake-selected"),
          ),
        ).toBe(true);
        expect(body(f.calls.at(-1))).toEqual(
          cloud
            ? parentKey === null
              ? { update: { parent: [{ set: { none: true } }] } }
              : { fields: { parent: { key: parentKey } } }
            : { issues: ["ENG-1"] },
        );
        if (!cloud)
          expect(f.calls.at(-1)?.url).toBe(
            `${selectedSite}/rest/agile/1.0/epic/${parentKey ?? "none"}/issue`,
          );
      }
      wrongSource = true;
      f.calls.length = 0;
      const error = yield* tracker.setParent!({ ...target, parentKey: "OPS-8" }).pipe(
        Effect.provideService(ConnectionId, "selected"),
        Effect.flip,
      );
      expect(error.reason).toBe("not-found");
      expect(f.calls.map(({ method }) => method)).toEqual(["GET"]);
      f.calls.length = 0;
      yield* tracker
        .getIssue(target)
        .pipe(Effect.provideService(ConnectionId, "selected"), Effect.flip);
      expect(f.calls.map(({ method }) => method)).toEqual(["GET"]);
      wrongSource = false;
      f.calls.length = 0;
      yield* tracker.setParent!({ ...target, parentKey: "OPS-8" }).pipe(
        Effect.provideService(ConnectionId, "missing-account"),
        Effect.flip,
      );
      yield* tracker.setParent!({
        ...target,
        host: cloud ? "foreign.atlassian.net" : host.replace("/Team/", "/team/"),
        parentKey: "OPS-8",
      }).pipe(Effect.provideService(ConnectionId, "selected"), Effect.flip);
      expect(f.calls).toHaveLength(0);
      for (const status of [403, 404]) {
        parentStatus = status;
        f.calls.length = 0;
        const error = yield* tracker.setParent!({ ...target, parentKey: "OPS-8" }).pipe(
          Effect.provideService(ConnectionId, "selected"),
          Effect.flip,
        );
        expect(JiraApi.isHttpStatus(error, status)).toBe(true);
        expect(f.calls.map(({ method }) => method)).toEqual(
          Array.from({ length: cloud ? 2 : 4 }, () => "GET"),
        );
      }
      parentStatus = 200;
      for (const status of [400, 403, 429]) {
        writeStatus = status;
        f.calls.length = 0;
        const error = yield* tracker.setParent!({ ...target, parentKey: "OPS-8" }).pipe(
          Effect.provideService(ConnectionId, "selected"),
          Effect.flip,
        );
        expect(JiraApi.isHttpStatus(error, status)).toBe(true);
        expect(f.calls.map(({ method }) => method)).toEqual([
          ...Array.from({ length: cloud ? 2 : 5 }, () => "GET"),
          cloud ? "PUT" : "POST",
        ]);
      }
    }),
);

it.effect("moves and removes a DC epic parent through native Agile routes with readback", () =>
  Effect.gen(function* () {
    const f = epicFixture();
    const tracker = yield* f.tracker;
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
    const detail = yield* tracker.getIssue(target);
    expect(detail.capabilities?.updateParent).toBe(true);
    expect(detail.viewerPermissions.updateParent).toBe(true);
    expect((yield* tracker.getViewerPermissions(target)).updateParent).toBeUndefined();
    expect((yield* tracker.getHierarchy!({ ...target, limit: 10 })).parent?.key).toBe("ENG-9");
    yield* tracker.setParent!({ ...target, parentKey: "ENG-2" });
    expect((yield* tracker.getHierarchy!({ ...target, limit: 10 })).parent?.key).toBe("ENG-2");
    yield* tracker.setParent!({ ...target, parentKey: null });
    expect((yield* tracker.getHierarchy!({ ...target, limit: 10 })).parent).toBeNull();
    const writes = f.calls.filter((r) => r.method === "POST" && r.url.includes("/agile/"));
    expect(writes.map((r) => r.url)).toEqual([
      `${site}/rest/agile/1.0/epic/ENG-2/issue`,
      `${site}/rest/agile/1.0/epic/none/issue`,
    ]);
    expect(writes.map(body)).toEqual([{ issues: ["ENG-1"] }, { issues: ["ENG-1"] }]);
    expect(f.calls.every((r) => r.headers.authorization === "Bearer fake-pat")).toBe(true);
    expect(f.calls.some((r) => r.method === "PUT" || r.url.includes("/subtask/move"))).toBe(false);
  }),
);

it.effect("pages both existing DC subtask children and native epic children", () =>
  Effect.gen(function* () {
    const f = epicFixture();
    const tracker = yield* f.tracker;
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-2", limit: 1 };
    const first = yield* tracker.getHierarchy!(target);
    expect(first.children.items.map((i) => i.key)).toEqual(["ENG-4"]);
    expect(first.children.nextCursor).not.toBeNull();
    const second = yield* tracker.getHierarchy!({ ...target, cursor: first.children.nextCursor! });
    expect(second.children.items.map((i) => i.key)).toEqual(["ENG-1"]);
    const last = yield* tracker.getHierarchy!({ ...target, cursor: second.children.nextCursor! });
    expect(last.children.items.map((i) => i.key)).toEqual(["ENG-3"]);
    expect(last.children.nextCursor).toBeNull();
  }),
);

it.effect.each([true, undefined] as const)(
  "keeps DC subtask or unknown parent edits unavailable: %s",
  (subtask) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        new URL(request.url).pathname.endsWith("/api/2/issue/ENG-1") && request.method === "GET"
          ? {
              body: {
                ...issue,
                changelog: { startAt: 0, total: 0, histories: [] },
                fields: {
                  ...issue.fields,
                  comment: { total: 0, comments: [] },
                  issuetype: {
                    id: "type",
                    name: "Type",
                    ...(subtask === undefined ? {} : { subtask }),
                  },
                },
              },
            }
          : undefined,
      );
      const tracker = yield* f.tracker;
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
      expect((yield* tracker.getIssue(target)).capabilities?.updateParent).toBe(false);
      expect((yield* tracker.getViewerPermissions(target)).updateParent).toBeUndefined();
      yield* tracker.setParent!({ ...target, parentKey: "ENG-2" }).pipe(Effect.flip);
      yield* tracker.setParent!({ ...target, parentKey: null }).pipe(Effect.flip);
      expect(f.calls.some((request) => request.method !== "GET")).toBe(false);
    }),
);

it.effect.each([403, 404])(
  "preserves core DC details and hierarchy when Agile reads return %s",
  (status) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.url.includes("/agile/") ? { status, body: {} } : undefined,
      );
      const tracker = yield* f.tracker;
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
      expect((yield* tracker.getIssue(target)).capabilities?.updateParent).toBe(false);
      expect((yield* tracker.getViewerPermissions(target)).updateParent).toBeUndefined();
      expect((yield* tracker.getHierarchy!({ ...target, limit: 10 })).children.items).toEqual([]);
      yield* tracker.setParent!({ ...target, parentKey: "ENG-2" }).pipe(Effect.flip);
      expect(f.calls.filter((r) => r.method === "POST" && r.url.includes("/agile/"))).toHaveLength(
        0,
      );
    }),
);

it.effect.each([400, 401, 403, 404, 429, 500])(
  "keeps native DC epic mutation HTTP %s without fallback or retry",
  (status) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.method === "POST" && request.url.includes("/agile/")
          ? { status, body: {} }
          : undefined,
      );
      const tracker = yield* f.tracker;
      const error = yield* tracker.setParent!({
        cwd: "/tmp",
        host,
        scope: "ENG",
        key: "ENG-1",
        parentKey: "ENG-2",
      }).pipe(Effect.flip);
      expect(error.detail).toContain(String(status));
      expect(f.calls.map(({ method }) => method)).toEqual([
        "GET",
        "GET",
        "GET",
        "GET",
        "GET",
        "POST",
      ]);
      expect(f.calls.some((r) => r.method === "PUT" || r.url.includes("/subtask/move"))).toBe(
        false,
      );
    }),
);

it.effect.each([401, 429, 500])("propagates optional Agile read HTTP %s", (status) =>
  Effect.gen(function* () {
    const f = epicFixture((request) =>
      request.url.includes("/agile/") ? { status, body: {} } : undefined,
    );
    const tracker = yield* f.tracker;
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
    const error = yield* tracker.getHierarchy!({ ...target, limit: 1 }).pipe(Effect.flip);
    expect(error.detail).toContain(String(status));
    expect(f.calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
  }),
);

it.effect.each([403, 404])(
  "keeps core subtasks when the optional epic child page returns HTTP %s",
  (status) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.method === "GET" && request.url.includes("/agile/1.0/epic/ENG-2/issue")
          ? { status, body: {} }
          : undefined,
      );
      const tracker = yield* f.tracker;
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-2", limit: 10 };
      const page = yield* tracker.getHierarchy!(target);
      expect(page.children.items.map((item) => item.key)).toEqual(["ENG-4"]);
      expect(page.children).toMatchObject({ nextCursor: null, truncated: true });
      f.calls.length = 0;
      const continuation = yield* tracker.getHierarchy!({ ...target, cursor: "epic:0" });
      expect(continuation.children).toEqual({ items: [], nextCursor: null, truncated: true });
      expect(f.calls.every((request) => request.method === "GET")).toBe(true);
    }),
);

it.effect.each([401, 429, 500])(
  "propagates optional epic child page HTTP %s after reading core subtasks",
  (status) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.method === "GET" && request.url.includes("/agile/1.0/epic/ENG-2/issue")
          ? { status, body: {} }
          : undefined,
      );
      const error = yield* (yield* f.tracker).getHierarchy!({
        cwd: "/tmp",
        host,
        scope: "ENG",
        key: "ENG-2",
        limit: 10,
      }).pipe(Effect.flip);
      expect(error.detail).toContain(String(status));
      expect(
        f.calls.filter((request) => request.url.includes("/agile/1.0/epic/ENG-2/issue")),
      ).toHaveLength(1);
      expect(f.calls.filter((request) => request.url.endsWith("/rest/api/2/search"))).toHaveLength(
        1,
      );
    }),
);

it.effect.each(["comment", "update", "setState"] as const)(
  "keeps the DC %s permission preflight to one request and independent of Agile",
  (operation) =>
    Effect.gen(function* () {
      const f = epicFixture((request) => {
        const path = new URL(request.url).pathname;
        if (path.includes("/agile/")) return { status: 500, body: {} };
        if (path.endsWith("/mypermissions"))
          return {
            body: {
              permissions: {
                EDIT_ISSUES: { havePermission: true },
                ADD_COMMENTS: { havePermission: true },
                TRANSITION_ISSUES: { havePermission: true },
              },
            },
          };
        if (path.endsWith("/transitions"))
          return request.method === "GET"
            ? { body: { transitions: [{ id: "advance", to: issue.fields.status }] } }
            : { status: 204 };
        if (request.method === "PUT") return { status: 204 };
        if (request.method === "POST" && path.endsWith("/comment"))
          return {
            body: {
              id: "100",
              body: "Native comment",
              author: user,
              created: issue.fields.created,
              updated: issue.fields.updated,
            },
          };
        return undefined;
      });
      const tracker = yield* f.tracker;
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
      const permissions = yield* tracker.getViewerPermissions(target);
      expect(permissions).toMatchObject({ edit: true, comment: true, setState: true });
      expect(permissions.updateParent).toBeUndefined();
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.url).toContain("/rest/api/2/mypermissions?");
      if (operation === "comment") yield* tracker.comment!({ ...target, body: "Native comment" });
      else if (operation === "update") yield* tracker.update!({ ...target, title: "Changed" });
      else
        yield* tracker.setState!({
          ...target,
          state: issue.fields.status.id,
          transitionId: "advance",
        });
      expect(f.calls.some((request) => request.url.includes("/agile/"))).toBe(false);
      expect(f.calls.filter((request) => request.method !== "GET")).toHaveLength(1);
    }),
);

it.effect.each(["ENG-1", "ENG-3", "OPS-1"])(
  "refuses a self or non-epic DC parent %s without writing",
  (parentKey) =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.url.includes("/rest/api/2/issue/OPS-1")
          ? {
              body: {
                ...issue,
                key: "OPS-1",
                fields: { ...issue.fields, project: { id: "30", key: "OPS" } },
              },
            }
          : undefined,
      );
      yield* (yield* f.tracker).setParent!({
        cwd: "/tmp",
        host,
        scope: "ENG",
        key: "ENG-1",
        parentKey,
      }).pipe(Effect.flip);
      expect(f.calls.every((r) => r.method === "GET")).toBe(true);
    }),
);

it.effect(
  "requires source edit permission in DC parent controls and propagates target denial",
  () =>
    Effect.gen(function* () {
      const f = epicFixture((request) =>
        request.url.includes("/mypermissions")
          ? { body: { permissions: { EDIT_ISSUES: { havePermission: false } } } }
          : request.url.includes("/agile/1.0/epic/ENG-2")
            ? { status: 403, body: {} }
            : undefined,
      );
      const tracker = yield* f.tracker;
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
      expect((yield* tracker.getIssue(target)).viewerPermissions.updateParent).toBe(false);
      expect((yield* tracker.getViewerPermissions(target)).updateParent).toBeUndefined();
      const error = yield* tracker.setParent!({ ...target, parentKey: "ENG-2" }).pipe(Effect.flip);
      expect(error.detail).toContain("403");
      expect(f.calls.every((r) => r.method === "GET")).toBe(true);
    }),
);

it.effect.each(["epic:bad", "epic:-1", "epic:1.5"])(
  "rejects malformed DC epic cursor %s without a child request",
  (cursor) =>
    Effect.gen(function* () {
      const f = epicFixture();
      yield* (yield* f.tracker).getHierarchy!({
        cwd: "/tmp",
        host,
        scope: "ENG",
        key: "ENG-2",
        limit: 1,
        cursor,
      }).pipe(Effect.flip);
      expect(f.calls.every((r) => r.method === "GET")).toBe(true);
      expect(f.calls.some((r) => r.url.includes("/epic/ENG-2/issue"))).toBe(false);
    }),
);

it.effect.each([
  { startAt: 1, total: 1, issues: [] },
  { startAt: 0, total: 1, issues: [] },
  { startAt: 0, total: 0, issues: [issue] },
])("rejects inconsistent native DC epic child page %j", (page) =>
  Effect.gen(function* () {
    const f = epicFixture((request) =>
      request.url.includes("/agile/1.0/epic/ENG-2/issue") ? { body: page } : undefined,
    );
    yield* (yield* f.tracker).getHierarchy!({
      cwd: "/tmp",
      host,
      scope: "ENG",
      key: "ENG-2",
      limit: 1,
      cursor: "epic:0",
    }).pipe(Effect.flip);
    expect(f.calls.filter((r) => r.url.includes("/epic/ENG-2/issue"))).toHaveLength(1);
    expect(f.calls.every((r) => r.method === "GET")).toBe(true);
  }),
);

it.effect("probes a DC PAT at the exact base path and pages its native project array", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) => ({
      body: request.url.endsWith("/myself")
        ? user
        : Array.from({ length: 102 }, (_, index) => ({
            id: String(index),
            key: `PRJ${index}`,
            name: `Project ${index}`,
          })),
    }));
    const api = yield* f.api;
    expect(yield* api.probeCredential(packed)).toEqual({
      account: "Ada",
      accountId: user.key,
      host,
      scopes: Array.from({ length: 100 }, (_, index) => ({
        key: `PRJ${index}`,
        name: `Project ${index}`,
      })),
      scopesCursor: "100",
      scopesTruncated: true,
    });
    expect(yield* api.listScopes(packed, { cursor: "100", limit: 2 })).toEqual({
      items: [
        { key: "PRJ100", name: "Project 100" },
        { key: "PRJ101", name: "Project 101" },
      ],
      nextCursor: null,
    });
    expect(f.calls.map((request) => request.url)).toEqual([
      `${site}/rest/api/2/myself`,
      `${site}/rest/api/2/project`,
      `${site}/rest/api/2/project`,
    ]);
    expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
      true,
    );
  }),
);

it.effect("maps DC offset search pages and stable user keys without changing wiki bodies", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { startAt: 2, total: 4, issues: [issue] } }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "listIssues",
      method: "POST",
      path: "/search/jql",
      body: {
        jql: 'project = "ENG"',
        maxResults: 2,
        nextPageToken: "2",
        fields: ["project", "summary"],
      },
      schema: Schema.Struct({
        issues: Schema.Array(JiraIssue),
        nextPageToken: Schema.optional(Schema.String),
        isLast: Schema.Boolean,
      }),
    });
    expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/search`);
    expect(body(f.calls[0])).toEqual({
      jql: 'project = "ENG"',
      maxResults: 2,
      startAt: 2,
      fields: ["project", "summary"],
    });
    expect(page.nextPageToken).toBe("3");
    expect(page.isLast).toBe(false);
    expect(page.issues[0]?.fields.creator?.accountId).toBe(user.key);
    expect(page.issues[0]?.fields.description).toBe(issue.fields.description);
  }),
);

it.effect("keeps DC native permission results and translates create metadata values", () =>
  Effect.gen(function* () {
    const denied = { permissions: { EDIT_ISSUES: { havePermission: false } } };
    const f = fakeJira((request) => ({
      body: request.url.includes("/mypermissions")
        ? denied
        : {
            start: 0,
            size: 100,
            last: true,
            values: [{ fieldId: "description", required: false }],
          },
    }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getViewerPermissions",
        method: "GET",
        path: "/mypermissions?issueKey=ENG-1&permissions=EDIT_ISSUES",
        schema: Schema.Unknown,
      }),
    ).toEqual(denied);
    expect(
      yield* api.request({
        host,
        operation: "create",
        method: "GET",
        path: "/issue/createmeta/ENG/issuetypes/100?startAt=0&maxResults=100",
        schema: Schema.Unknown,
      }),
    ).toMatchObject({ fields: [{ fieldId: "description", required: false }] });
  }),
);

it.effect(
  "uses the selected account for DC requests and rejects another instance before HTTP",
  () =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({ body: user }), {
        default: JSON.stringify({
          site: "cloud.atlassian.net",
          email: "cloud@test",
          token: "cloud",
        }),
        dc: packed,
      });
      const api = yield* f.api;
      const read = (requestedHost: string) =>
        api
          .request({
            host: requestedHost,
            operation: "getViewer",
            method: "GET",
            path: "/myself",
            schema: JiraUser,
          })
          .pipe(Effect.provideService(ConnectionId, "dc"));
      expect((yield* read(host)).accountId).toBe(user.key);
      for (const other of ["jira.example.test:8443/team/Jira", "jira.example.test:9443/Team/Jira"])
        expect(yield* read(other).pipe(Effect.flip)).toMatchObject({ reason: "unauthenticated" });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.headers.authorization).toBe("Bearer fake-pat");
    }),
);

it.effect("rejects rich ADF writes to DC before sending a mutation", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 204 }));
    const api = yield* f.api;
    const rich = textToAdf("keep bold");
    const document = {
      ...rich,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "bold", marks: [{ type: "strong" }] }],
        },
      ],
    };
    expect(
      yield* api
        .request({
          host,
          operation: "update",
          method: "PUT",
          path: "/issue/ENG-1",
          body: { fields: { description: document } },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("reads deployment from the selected credential without HTTP", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 500 }), {
      default: JSON.stringify({ site: "cloud.atlassian.net", email: "cloud@test", token: "cloud" }),
      dc: packed,
    });
    const api = yield* f.api;
    expect(yield* api.deploymentFor("cloud.atlassian.net")).toBe("cloud");
    expect(yield* api.deploymentFor(host).pipe(Effect.provideService(ConnectionId, "dc"))).toBe(
      "data-center",
    );
    expect(yield* api.deploymentFor(host).pipe(Effect.flip)).toMatchObject({
      reason: "unauthenticated",
    });
    expect(JiraApi.jiraIssueUrl(host, "ENG-1")).toBe(`${site}/browse/ENG-1`);
    expect(JiraApi.normalizeJiraInstanceHost("https://JIRA.example.test:8443/Team/Jira/")).toBe(
      host,
    );
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("resolves a stable DC assignee key and writes native user names and string bodies", () =>
  Effect.gen(function* () {
    const f = fakeJira((request) =>
      request.url.includes("/user?key=") ? { body: user } : { status: 204 },
    );
    const api = yield* f.api;
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1",
      body: {
        fields: {
          assignee: { accountId: user.key },
          description: textToAdf("first\nsecond\n\nthird"),
        },
      },
      schema: Schema.Undefined,
    });
    expect(f.calls.map((request) => request.url)).toEqual([
      `${site}/rest/api/2/user?key=JIRAUSER101`,
      `${site}/rest/api/2/issue/ENG-1`,
    ]);
    expect(body(f.calls[1])).toEqual({
      fields: { assignee: { name: "ada.renamed" }, description: "first\nsecond\n\nthird" },
    });
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1/assignee",
      body: { accountId: user.key },
      schema: Schema.Undefined,
    });
    expect(body(f.calls[3])).toEqual({ name: "ada.renamed" });
    yield* api.request({
      host,
      operation: "update",
      method: "PUT",
      path: "/issue/ENG-1/assignee",
      body: { accountId: null },
      schema: Schema.Undefined,
    });
    expect(body(f.calls[4])).toEqual({ name: null });
    expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
      true,
    );
  }),
);

it.effect("does not mutate when DC cannot resolve the selected native account key", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { ...user, key: "JIRAUSER999" } }));
    const api = yield* f.api;
    expect(
      yield* api
        .request({
          host,
          operation: "update",
          method: "PUT",
          path: "/issue/ENG-1/assignee",
          body: { accountId: user.key },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls.map((request) => request.method)).toEqual(["GET"]);
  }),
);

it.effect("keeps native wiki comment bodies and uses public v2 comment operations", () =>
  Effect.gen(function* () {
    const comment = {
      id: "30",
      author: user,
      body: issue.fields.description,
      created: issue.fields.created,
      updated: issue.fields.updated,
    };
    const f = fakeJira((request) => ({
      body:
        request.method === "GET" && !request.url.endsWith("/30")
          ? { startAt: 0, total: 1, comments: [comment] }
          : comment,
    }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "getComments",
      method: "GET",
      path: "/issue/ENG-1/comment?orderBy=-created&startAt=0&maxResults=50",
      schema: Schema.Struct({
        comments: Schema.Array(Schema.Struct({ body: Schema.String, author: JiraUser })),
      }),
    });
    expect(page.comments[0]).toMatchObject({ body: comment.body, author: { accountId: user.key } });
    for (const method of ["POST", "PUT"] as const) {
      yield* api.request({
        host,
        operation: method === "POST" ? "comment" : "editComment",
        method,
        path: "/issue/ENG-1/comment" + (method === "PUT" ? "/30" : ""),
        body: { body: comment.body },
        schema: Schema.Unknown,
      });
      expect(body(f.calls.at(-1))).toEqual({ body: comment.body });
    }
    expect(f.calls[0]?.url).toBe(
      `${site}/rest/api/2/issue/ENG-1/comment?orderBy=-created&startAt=0&maxResults=50`,
    );
  }),
);

it.effect("adapts DC expanded changelog reads and refuses incomplete native history", () =>
  Effect.gen(function* () {
    const histories = Array.from({ length: 3 }, (_, index) => ({
      id: String(index),
      author: user,
      created: issue.fields.created,
      items: [],
    }));
    let total = 3;
    const f = fakeJira(() => ({ body: { changelog: { startAt: 0, total, histories } } }));
    const api = yield* f.api;
    const read = () =>
      api.request({
        host,
        operation: "getHistory",
        method: "GET",
        path: "/issue/ENG-1/changelog?startAt=1&maxResults=1",
        schema: Schema.Struct({
          startAt: Schema.Int,
          total: Schema.Int,
          isLast: Schema.Boolean,
          values: Schema.Array(Schema.Struct({ id: Schema.String, author: JiraUser })),
        }),
      });
    expect(yield* read()).toMatchObject({
      startAt: 1,
      total: 3,
      isLast: false,
      values: [{ id: "1", author: { accountId: user.key } }],
    });
    expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/issue/ENG-1?fields=project&expand=changelog`);
    total = 4;
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "failed" });
  }),
);

it.effect(
  "adapts DC issue type pages and keeps scope reads bound to their supplied credential",
  () =>
    Effect.gen(function* () {
      const f = fakeJira(
        (request) => ({
          body: request.url.includes("/issuetypes")
            ? {
                start: 0,
                size: 100,
                last: true,
                values: [{ id: "100", name: "Task", subtask: false }],
              }
            : { key: "ENG", name: "Engineering" },
        }),
        {},
      );
      const api = yield* f.api;
      expect(yield* api.getScope(packed, "ENG")).toEqual({ key: "ENG", name: "Engineering" });
      expect(
        yield* api.request({
          host,
          credential: packed,
          operation: "issueTypes",
          method: "GET",
          path: "/issue/createmeta/ENG/issuetypes?startAt=0&maxResults=100",
          schema: Schema.Unknown,
        }),
      ).toMatchObject({
        issueTypes: [{ id: "100", name: "Task", subtask: false }],
      });
      expect(f.calls[0]?.url).toBe(`${site}/rest/api/2/project/ENG`);
    }),
);

it.effect.each([
  "https://jira.example.test/Team/Jira",
  "http://jira.example.test:8443/Team/Jira",
  "https://user:pass@jira.example.test/Team/Jira",
  "https://jira.example.test/Team/Jira?other=1",
  "https://jira.example.test/Team/Jira#other",
])("does not let a legacy Cloud credential select the DC instance %s", (site) =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: user }));
    const api = yield* f.api;
    expect(
      yield* api
        .probeCredential(JSON.stringify({ site, email: "ada@test", token: "fake-token" }))
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "unauthenticated" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect.each(["opaque-cloud-token", "-1", "01", "9007199254740992"])(
  "rejects an invalid DC search cursor %s before HTTP",
  (cursor) =>
    Effect.gen(function* () {
      const f = fakeJira(() => ({ body: { startAt: 0, total: 0, issues: [] } }));
      const api = yield* f.api;
      expect(
        yield* api
          .request({
            host,
            operation: "listIssues",
            method: "POST",
            path: "/search/jql",
            body: { jql: "project = ENG", maxResults: 2, nextPageToken: cursor },
            schema: Schema.Struct({ issues: Schema.Array(JiraIssue) }),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "failed" });
      expect(f.calls).toHaveLength(0);
    }),
);

it.effect("preserves DC rate-limit and response-size budgets", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 429, body: {}, headers: { "retry-after": "60" } }));
    const api = yield* f.api;
    const read = () =>
      api.request({
        host,
        operation: "getViewer",
        method: "GET",
        path: "/myself",
        schema: JiraUser,
      });
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "rate-limited" });
    expect(yield* read().pipe(Effect.flip)).toMatchObject({ reason: "rate-limited" });
    expect(f.calls).toHaveLength(1);
    const oversized = fakeJira(() => ({
      body: { ...user, displayName: "x".repeat(2 * 1024 * 1024) },
    }));
    const largeApi = yield* oversized.api;
    expect(
      yield* largeApi
        .request({ host, operation: "getViewer", method: "GET", path: "/myself", schema: JiraUser })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
  }),
);

it.effect("does not invent a total for a DC metadata page that reports more rows", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        start: 100,
        size: 100,
        last: false,
        values: [{ fieldId: "summary", required: true }],
      },
    }));
    const api = yield* f.api;
    const page = yield* api.request({
      host,
      operation: "create",
      method: "GET",
      path: "/issue/createmeta/ENG/issuetypes/100?startAt=100&maxResults=100",
      schema: Schema.Struct({
        startAt: Schema.Int,
        isLast: Schema.Boolean,
        total: Schema.optional(Schema.Int),
      }),
    });
    expect(page).toEqual({ startAt: 100, isLast: false });
  }),
);

it.effect("limits DC assignable-user reads to the documented first 100 native users", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: [user] }));
    const api = yield* f.api;
    const read = (startAt: number) =>
      api.request({
        host,
        operation: "listAssigneeCandidates",
        method: "GET",
        path: `/user/assignable/search?project=ENG&startAt=${startAt}&maxResults=200`,
        schema: Schema.Array(JiraUser),
      });
    expect((yield* read(0))[0]?.accountId).toBe(user.key);
    expect(f.calls[0]?.url).toBe(
      `${site}/rest/api/2/user/assignable/search?project=ENG&maxResults=100`,
    );
    expect(yield* read(100).pipe(Effect.flip)).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect("rejects DC parent mutations without pretending a permission grant supports them", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ status: 204 }));
    const api = yield* f.api;
    expect(
      yield* api
        .request({
          host,
          operation: "setParent",
          method: "PUT",
          path: "/issue/ENG-1",
          body: { fields: { parent: { key: "ENG-2" } } },
          schema: Schema.Undefined,
        })
        .pipe(Effect.flip),
    ).toMatchObject({ reason: "failed" });
    expect(f.calls).toHaveLength(0);
  }),
);

it.effect("uses the native username only when a legacy DC user has no key", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({ body: { name: "legacy.user", displayName: "Legacy" } }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getViewer",
        method: "GET",
        path: "/myself",
        schema: JiraUser,
      }),
    ).toMatchObject({ accountId: "legacy.user" });
  }),
);

it.each(["https://jira.example.test/Team/../Other", "https://jira.example.test/Team/%2e%2e/Other"])(
  "rejects a DC instance URL that normalizes a different native base path: %s",
  (site) => expect(() => JiraApi.normalizeJiraInstanceHost(site)).toThrow(),
);

it.effect("keeps embedded DC history truncation visible and reloads displaced comment pages", () =>
  Effect.gen(function* () {
    const f = fakeJira(() => ({
      body: {
        ...issue,
        fields: {
          ...issue.fields,
          comment: {
            startAt: 10,
            total: 20,
            comments: [
              {
                id: "c1",
                author: user,
                body: "keep",
                created: issue.fields.created,
                updated: issue.fields.updated,
              },
            ],
          },
        },
        changelog: {
          histories: Array.from({ length: 101 }, (_, index) => ({
            id: String(index),
            author: user,
            created: issue.fields.created,
            items: [],
          })),
        },
      },
    }));
    const api = yield* f.api;
    const detail = yield* api.request({
      host,
      operation: "getIssue",
      method: "GET",
      path: "/issue/ENG-1?expand=changelog",
      schema: JiraIssue,
    });
    expect(detail.changelog?.histories).toHaveLength(100);
    expect(detail.changelog?.total).toBe(101);
    expect(detail.fields.comment).toEqual({ startAt: 10, total: 20 });
  }),
);

it.effect.each(["listIssues", "listLabelCandidates", "getHierarchy", "listCandidates"] as const)(
  "runs DC %s through the real tracker and transport with native search field arrays",
  (operation) =>
    Effect.gen(function* () {
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1", viewer: user.key };
      const f = fakeJira((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/search")) {
          const search = decodeSearchRequest(body(request));
          const child = search.jql.startsWith("parent = ") || search.startAt > 0;
          return {
            body: {
              startAt: search.startAt,
              total: operation === "listIssues" ? 2 : 1,
              issues: [
                {
                  ...issue,
                  key: child ? "ENG-2" : "ENG-1",
                  fields: {
                    ...issue.fields,
                    labels: ["bug"],
                    ...(child ? { parent: { key: "ENG-1" } } : {}),
                  },
                },
              ],
            },
          };
        }
        if (path.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (path.endsWith("/transitions")) return { body: { transitions: [] } };
        if (path.endsWith("/statuses")) return { body: [{ statuses: [issue.fields.status] }] };
        return { body: issue };
      });
      const tracker = yield* JiraIssueTracker.make.pipe(
        Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
      );
      if (operation === "listIssues") {
        const first = yield* tracker.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          limit: 1,
        });
        expect(first.items[0]?.key).toBe("ENG-1");
        expect(first.nextCursor).toBe("1");
        const second = yield* tracker.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          limit: 1,
          cursor: first.nextCursor!,
        });
        expect(second.items[0]?.key).toBe("ENG-2");
        expect(second.nextCursor).toBeNull();
      } else if (operation === "listLabelCandidates") {
        expect(yield* tracker.listLabelCandidates!({ ...target, limit: 1 })).toEqual({
          items: [{ name: "bug", color: null, description: null }],
          nextCursor: null,
        });
      } else if (operation === "getHierarchy") {
        const hierarchy = yield* tracker.getHierarchy!({ ...target, limit: 1 });
        expect(hierarchy.parent).toBeNull();
        expect(hierarchy.children.items[0]).toMatchObject({
          key: "ENG-2",
          url: `${site}/browse/ENG-2`,
        });
        expect(hierarchy.children.nextCursor).toBeNull();
      } else {
        const candidates = yield* tracker.listCandidates!(target);
        expect(candidates.labels).toEqual([{ name: "bug", color: null, description: null }]);
        expect(candidates.assignees).toEqual([]);
      }
      const searches = f.calls.filter((request) => request.method === "POST");
      expect(searches).toHaveLength(operation === "listIssues" ? 2 : 1);
      for (const request of searches) {
        expect(request.url).toBe(`${site}/rest/api/2/search`);
        expect(body(request)).toMatchObject({
          fields: expect.arrayContaining(["project", "labels"]),
          startAt: expect.any(Number),
        });
        expect(body(request)).not.toHaveProperty("nextPageToken");
      }
      expect(f.calls.every((request) => request.headers.authorization === "Bearer fake-pat")).toBe(
        true,
      );
    }),
);

it.effect("normalizes complete DC embedded comments to a bounded newest page", () =>
  Effect.gen(function* () {
    const comments = Array.from({ length: 60 }, (_, index) => ({
      id: String(index + 1),
      body: "Native wiki",
      created: "2026-10-15T10:" + String(index).padStart(2, "0") + ":00Z",
      updated: issue.fields.updated,
    }));
    const f = fakeJira(() => ({
      body: {
        ...issue,
        fields: { ...issue.fields, comment: { startAt: 0, maxResults: 60, total: 60, comments } },
      },
    }));
    const api = yield* f.api;
    expect(
      yield* api.request({
        host,
        operation: "getIssue",
        method: "GET",
        path: "/issue/ENG-1",
        schema: Schema.Unknown,
      }),
    ).toMatchObject({
      fields: { comment: { startAt: 0, maxResults: 50, total: 60, comments: comments.slice(-50) } },
    });
    expect(f.calls).toHaveLength(1);
  }),
);

it.effect.each([
  { name: "complete 60", total: 60, startAt: 0, embedded: 60, offsets: [0, 50], canEdit: true },
  { name: "incomplete 60", total: 60, startAt: 0, embedded: 10, offsets: [0, 50], canEdit: true },
  { name: "displaced 60", total: 60, startAt: 10, embedded: 10, offsets: [0, 50], canEdit: false },
  { name: "complete 50", total: 50, startAt: 0, embedded: 50, offsets: [], canEdit: true },
  { name: "complete 3", total: 3, startAt: 0, embedded: 3, offsets: [], canEdit: false },
  { name: "empty", total: 0, startAt: 0, embedded: 0, offsets: [], canEdit: false },
])("loads every DC comment exactly once for $name embedded comments", (scenario) =>
  Effect.gen(function* () {
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
    const native = Array.from({ length: scenario.total }, (_, index) => ({
      id: String(index + 1),
      author: user,
      body: `Comment ${index + 1}`,
      created: `2026-10-15T10:${String(index).padStart(2, "0")}:00Z`,
      updated: `2026-10-15T10:${String(index).padStart(2, "0")}:00Z`,
    }));
    const f = fakeJira((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/myself")) return { body: user };
      if (url.pathname.endsWith("/mypermissions"))
        return {
          body: { permissions: { EDIT_OWN_COMMENTS: { havePermission: scenario.canEdit } } },
        };
      if (url.pathname.endsWith("/remotelink")) return { body: [] };
      if (url.pathname.endsWith("/comment")) {
        const startAt = Number(url.searchParams.get("startAt"));
        const maxResults = Number(url.searchParams.get("maxResults"));
        expect(url.searchParams.get("orderBy")).toBe("-created");
        expect(maxResults).toBe(50);
        return {
          body: {
            startAt,
            maxResults,
            total: native.length,
            comments: native.toReversed().slice(startAt, startAt + maxResults),
          },
        };
      }
      if (url.pathname.endsWith("/issue/ENG-1"))
        return {
          body: {
            ...issue,
            fields: {
              ...issue.fields,
              comment: {
                startAt: scenario.startAt,
                maxResults: scenario.embedded,
                total: native.length,
                comments: native.slice(scenario.startAt, scenario.startAt + scenario.embedded),
              },
            },
            changelog: { startAt: 0, total: 0, histories: [] },
          },
        };
      throw new Error(`Unexpected fake Jira request: ${request.url}`);
    });
    const tracker = yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
    );
    const detail = yield* tracker.getIssue(target);
    const loaded = [...detail.comments];
    let cursor = detail.commentsCursor;
    for (let page = 0; cursor !== null && page < 2; page++) {
      const next = yield* tracker.getComments({ ...target, cursor, viewer: user.key });
      loaded.push(...next.comments);
      cursor = next.nextCursor;
    }
    const ids = loaded.map((comment) => comment.id);
    expect(ids).toHaveLength(scenario.total);
    expect(new Set(ids).size).toBe(scenario.total);
    expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(
      native.map((comment) => comment.id),
    );
    expect(detail.comments.map((comment) => comment.id)).toEqual(
      native
        .slice(-50)
        .toReversed()
        .map((comment) => comment.id),
    );
    expect(detail.comments).toHaveLength(Math.min(50, scenario.total));
    if (scenario.total > 50) expect(detail.commentsCursor).toEqual(expect.any(String));
    else expect(detail.commentsCursor).toBeNull();
    expect(cursor).toBeNull();
    expect(loaded.every((comment) => comment.canEdit === scenario.canEdit)).toBe(true);
    for (const comment of loaded)
      expect(comment.richBody).toEqual({ format: "jira-wiki", document: comment.body });
    expect(detail.bodyEditable).toBe(false);
    const pages = f.calls.filter((request) => new URL(request.url).pathname.endsWith("/comment"));
    expect(
      pages.map((request) => Number(new URL(request.url).searchParams.get("startAt"))),
    ).toEqual(scenario.offsets);
    expect(f.calls).toHaveLength(
      4 + scenario.offsets.reduce((total, offset) => total + (offset === 0 ? 1 : 3), 0),
    );
    expect(
      f.calls.every(
        (request) =>
          request.method === "GET" && request.headers.authorization === "Bearer fake-pat",
      ),
    ).toBe(true);
  }),
);

it.effect("stops DC comment loading when native comment permissions return 403", () =>
  Effect.gen(function* () {
    let denied = false;
    const f = fakeJira((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/issue/ENG-1"))
        return {
          body: {
            ...issue,
            changelog: { startAt: 0, total: 0, histories: [] },
            fields: { ...issue.fields, comment: { startAt: 0, total: 51 } },
          },
        };
      if (path.endsWith("/mypermissions"))
        return denied ? { status: 403 } : { body: { permissions: {} } };
      if (path.endsWith("/myself")) return { body: user };
      if (path.endsWith("/remotelink")) return { body: [] };
      if (path.endsWith("/comment"))
        return {
          body: {
            startAt: 0,
            total: 51,
            comments: Array.from({ length: 50 }, (_, index) => ({
              id: String(51 - index),
              author: user,
              body: "Native comment",
              created: issue.fields.created,
              updated: issue.fields.updated,
            })),
          },
        };
      throw new Error(`Unexpected fake Jira request: ${request.url}`);
    });
    const tracker = yield* JiraIssueTracker.make.pipe(
      Effect.provideServiceEffect(JiraApi.JiraApi, f.api),
    );
    const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1", viewer: user.key };
    const detail = yield* tracker.getIssue(target);
    expect(detail.commentsCursor).not.toBeNull();
    const before = f.calls.length;
    denied = true;
    expect(
      yield* tracker.getComments({ ...target, cursor: detail.commentsCursor! }).pipe(Effect.flip),
    ).toMatchObject({
      operation: "getComments",
      reason: "failed",
      detail: "Jira returned HTTP 403.",
    });
    expect(f.calls.slice(before).map((request) => new URL(request.url).pathname)).toEqual([
      "/Team/Jira/rest/api/2/issue/ENG-1",
      "/Team/Jira/rest/api/2/mypermissions",
    ]);
    expect(f.calls.every((request) => request.method === "GET")).toBe(true);
  }),
);

it.effect.each(["asc", "desc"] as const)(
  "orders complete 205-row DC history before clipping and offset paging from native %s",
  (nativeOrder) =>
    Effect.gen(function* () {
      const orderedIds = [2, 205, ...Array.from({ length: 202 }, (_, index) => index + 3), 1];
      const chronological = orderedIds.map((id, index) => ({
        id: String(id),
        author: user,
        created:
          "2026-10-16T" +
          String(10 + Math.floor(index / 120)).padStart(2, "0") +
          ":" +
          String(Math.floor(index / 2) % 60).padStart(2, "0") +
          ":00Z",
        items: [{ field: "summary", fromString: "Before", toString: String(id) }],
      }));
      const histories = nativeOrder === "desc" ? chronological.toReversed() : chronological;
      const f = fakeJira((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/myself")) return { body: user };
        if (path.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (path.endsWith("/remotelink")) return { body: [] };
        if (path.endsWith("/issue/ENG-1"))
          return {
            body: {
              ...issue,
              fields: { ...issue.fields, comment: { startAt: 0, total: 0, comments: [] } },
              changelog: { startAt: 0, total: 205, histories },
            },
          };
        throw new Error(`Unexpected fake Jira request: ${request.url}`);
      });
      const api = yield* f.api;
      const tracker = yield* JiraIssueTracker.make.pipe(
        Effect.provideService(JiraApi.JiraApi, api),
      );
      const target = { cwd: "/tmp", host, scope: "ENG", key: "ENG-1" };
      const detail = yield* tracker.getIssue(target);
      expect(detail.events.map((event) => event.detail)).toEqual(
        [1, ...Array.from({ length: 49 }, (_, index) => 204 - index)].map(String),
      );
      expect(detail.historyTruncated).toBe(true);
      expect(f.calls).toHaveLength(4);
      const expanded = yield* api.request({
        host,
        operation: "getIssue",
        method: "GET",
        path: "/issue/ENG-1?fields=project&expand=changelog",
        schema: JiraIssue,
      });
      expect(expanded.changelog).toMatchObject({ startAt: 105, total: 205 });
      expect(expanded.changelog?.histories.map((entry) => entry.id)).toEqual(
        [...Array.from({ length: 99 }, (_, index) => 106 + index), 1].map(String),
      );
      for (const order of ["asc", "desc"] as const) {
        const loaded: string[] = [];
        const requestCounts: number[] = [];
        let cursor: string | undefined;
        do {
          const before = f.calls.length;
          const page = yield* tracker.getHistory!({
            ...target,
            order,
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          });
          requestCounts.push(f.calls.length - before);
          loaded.push(...page.items.map((event) => event.detail!));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && loaded.length <= 205);
        expect(cursor).toBeUndefined();
        expect(loaded).toEqual(
          (order === "desc" ? orderedIds.toReversed() : orderedIds).map(String),
        );
        expect(new Set(loaded).size).toBe(205);
        expect(requestCounts).toEqual(order === "desc" ? [1, 2, 2, 2, 2] : [2, 2, 2, 2, 2]);
      }
      const pageSchema = Schema.Struct({
        startAt: Schema.Int,
        total: Schema.Int,
        isLast: Schema.Boolean,
        values: Schema.Array(Schema.Struct({ id: Schema.String })),
      });
      for (const [startAt, limit, ids] of [
        [0, 2, ["2", "205"]],
        [8, 2, ["9", "10"]],
        [200, 5, ["201", "202", "203", "204", "1"]],
        [205, 5, []],
      ] as const) {
        const before = f.calls.length;
        const page = yield* api.request({
          host,
          operation: "getHistory",
          method: "GET",
          path: "/issue/ENG-1/changelog?startAt=" + startAt + "&maxResults=" + limit,
          schema: pageSchema,
        });
        expect(page).toMatchObject({ startAt, total: 205, isLast: startAt + limit >= 205 });
        expect(page.values.map((entry) => entry.id)).toEqual(ids);
        expect(f.calls).toHaveLength(before + 1);
      }
      expect(f.calls).toHaveLength(28);
      expect(
        f.calls.every(
          (request) =>
            request.method === "GET" && request.headers.authorization === "Bearer fake-pat",
        ),
      ).toBe(true);
    }),
);

it.effect.each(["asc", "desc"] as const)(
  "selects the true newest complete embedded DC comments from native %s before clipping",
  (nativeOrder) =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 205 }, (_, index) => ({
        id: String(index + 1),
        body: "Native wiki",
        author: user,
        created:
          "2026-10-16T" +
          String(10 + Math.floor(index / 60)).padStart(2, "0") +
          ":" +
          String(index % 60).padStart(2, "0") +
          ":00Z",
        updated: issue.fields.updated,
      }));
      const f = fakeJira(() => ({
        body: {
          ...issue,
          fields: {
            ...issue.fields,
            comment: {
              startAt: 0,
              total: 205,
              comments: nativeOrder === "desc" ? comments.toReversed() : comments,
            },
          },
        },
      }));
      const api = yield* f.api;
      const result = yield* api.request({
        host,
        operation: "getIssue",
        method: "GET",
        path: "/issue/ENG-1",
        schema: JiraIssue,
      });
      expect(result.fields.comment).toMatchObject({ startAt: 0, total: 205 });
      expect(result.fields.comment?.comments?.map((entry) => entry.id)).toEqual(
        Array.from({ length: 50 }, (_, index) => String(index + 156)),
      );
      expect(f.calls).toHaveLength(1);
    }),
);

it.effect.each([{ created: "not-a-native-date" }, { created: "" }, { id: "" }])(
  "refuses malformed complete DC history rows before a clipped window: %j",
  (invalid) =>
    Effect.gen(function* () {
      const histories = Array.from({ length: 205 }, (_, index) => ({
        id: String(index + 1),
        author: user,
        created: issue.fields.created,
        items: [],
      }));
      const f = fakeJira((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/myself")) return { body: user };
        if (path.endsWith("/mypermissions")) return { body: { permissions: {} } };
        if (path.endsWith("/remotelink")) return { body: [] };
        return {
          body: {
            ...issue,
            fields: { ...issue.fields, comment: { total: 0, comments: [] } },
            changelog: {
              startAt: 0,
              total: 205,
              histories: [{ ...histories[0], ...invalid }, ...histories.slice(1)],
            },
          },
        };
      });
      const api = yield* f.api;
      const tracker = yield* JiraIssueTracker.make.pipe(
        Effect.provideService(JiraApi.JiraApi, api),
      );
      expect(
        (yield* tracker
          .getIssue({ cwd: "/tmp", host, scope: "ENG", key: "ENG-1" })
          .pipe(Effect.flip)).reason,
      ).toBe("failed");
      expect(f.calls).toHaveLength(1);
      expect(
        (yield* api
          .request({
            host,
            operation: "getHistory",
            method: "GET",
            path: "/issue/ENG-1/changelog?startAt=155&maxResults=50",
            schema: Schema.Unknown,
          })
          .pipe(Effect.asVoid, Effect.flip)).reason,
      ).toBe("failed");
      expect(f.calls).toHaveLength(2);
    }),
);
