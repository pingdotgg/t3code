import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import type {
  IssueTrackerCredential,
  StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const SERVER = "https://jira.corp/jira";
const STORED: IssueTrackerCredential = { token: "pat", fields: { site: `${SERVER}/` } };

const user = (name: string, displayName = name) => ({ name, key: `JIRAUSER-${name}`, displayName });
const status = (name: string, category: string) => ({ name, statusCategory: { key: category } });

const issue = (key: string, fields: Record<string, unknown> = {}, extra = {}) => ({
  id: "10001",
  key,
  fields: {
    summary: `Issue ${key}`,
    status: status("In Progress", "indeterminate"),
    resolution: null,
    resolutiondate: null,
    created: "2026-07-01T10:00:00.000+0000",
    updated: "2026-07-02T10:00:00.000+0200",
    reporter: user("julius", "Julius"),
    assignee: user("theo", "Theo"),
    labels: ["bug"],
    description: "h2. Why\nIt is *broken*.",
    ...fields,
  },
  ...extra,
});

interface Seen {
  readonly route: string;
  readonly origin: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown> | null;
}

type Answer = unknown | Response;

/** Answers each route (`GET /issue/PROJ-1`, below `/rest/api/2`) as Data Center would. */
function fakeDataCenter(
  answers: Record<string, (seen: Seen) => Answer>,
  stored: IssueTrackerCredential = STORED,
) {
  const requests: Seen[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        for (const [key, value] of request.urlParams.params) {
          if (typeof value === "string") url.searchParams.append(key, value);
        }
        const body = request.body;
        const seen: Seen = {
          route: `${request.method} ${url.pathname.replace(/^.*?\/rest\/api\/2/, "") || url.pathname}`,
          origin: `${url.origin}${url.pathname.split("/rest/api/")[0]}`,
          query: url.searchParams,
          authorization: request.headers.authorization,
          body: body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null,
        };
        requests.push(seen);
        const answer = answers[seen.route]?.(seen);
        const response =
          answer instanceof Response
            ? answer
            : answers[seen.route] === undefined
              ? Response.json({ errorMessages: [`No answer for ${seen.route}`] }, { status: 400 })
              : answer === undefined
                ? new Response(null, { status: 204 })
                : Response.json(answer);
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeedSome(stored) },
    }),
  );
  const tracker = JiraIssueTracker.make.pipe(
    Effect.map(
      (api) =>
        api as StandaloneIssueTrackerApi &
          Required<
            Pick<
              StandaloneIssueTrackerApi,
              "create" | "comment" | "update" | "setState" | "listCandidates"
            >
          >,
    ),
    Effect.provide(JiraApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "atlassian.net", scope: "PROJ" };
const listInput = {
  ...target,
  state: "open",
  involvement: "all",
  viewer: "Julius",
  limit: 2,
  sort: "updated",
} as const;

describe("JiraIssueTracker on Data Center", () => {
  it.effect("vets a token against the server it names, sending it as a bearer", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({
        "GET /serverInfo": () => ({ version: "8.21.0", versionNumbers: [8, 21, 0] }),
        "GET /myself": () => user("julius", "Julius"),
        "GET /project": () => [
          { key: "PROJ", name: "Project" },
          { key: "OPS", name: "Operations" },
        ],
      });
      const api = yield* tracker;
      const probe = yield* api.probeCredential({
        token: "pat_new",
        fields: { site: "https://other.corp:8443/jira/" },
      });
      expect(probe).toEqual({
        account: "Julius",
        scopes: [
          { key: "PROJ", name: "Project" },
          { key: "OPS", name: "Operations" },
        ],
      });
      expect(
        Object.fromEntries(requests.map((request) => [request.route, request.authorization])),
      ).toEqual({
        "GET /serverInfo": undefined,
        "GET /myself": "Bearer pat_new",
        "GET /project": "Bearer pat_new",
      });
      expect(new Set(requests.map((request) => request.origin))).toEqual(
        new Set(["https://other.corp:8443/jira"]),
      );
    }),
  );

  it.effect("names the version when a server is too old for access tokens", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({
        "GET /serverInfo": () => ({ version: "8.13.5", versionNumbers: [8, 13, 5] }),
        "GET /myself": () => new Response(null, { status: 401 }),
        "GET /project": () => [],
      });
      const api = yield* tracker;
      const refused = yield* api.probeCredential(STORED).pipe(Effect.flip);
      expect(refused.detail).toBe(
        "Jira 8.13.5 has no personal access tokens. T3 Code needs Jira Data Center 8.14 or later.",
      );
      expect(requests.map((request) => request.route)).not.toContain("GET /myself");
    }),
  );

  it.effect("sends every call of the saved account to its server's v2 routes", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({
        "GET /user/search": () => [user("theo", "Theo")],
        "POST /search": () => ({ total: 0, issues: [] }),
      });
      const api = yield* tracker;
      yield* api.listIssues({ ...listInput, assignee: "Theo" });
      expect(
        requests.map((request) => [request.route, request.origin, request.authorization]),
      ).toEqual([
        ["GET /user/search", SERVER, "Bearer pat"],
        ["POST /search", SERVER, "Bearer pat"],
      ]);
      expect(requests[0]?.query.get("username")).toBe("Theo");
    }),
  );

  it.effect("refuses a Data Center connection it cannot reach with a bearer", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({});
      const api = yield* tracker;
      for (const site of ["jira.corp", "ftp://jira.corp", "https://user:pw@jira.corp", ""]) {
        const refused = yield* api
          .probeCredential({ token: "t", fields: { site } })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("unauthenticated");
      }
      // A Cloud site without its account email would be sent a bearer it does not read.
      const cloud = yield* api
        .probeCredential({ token: "t", fields: { site: "https://acme.atlassian.net" } })
        .pipe(Effect.flip);
      expect(cloud.detail).toBe("Jira Cloud needs the account email.");
      expect(requests).toHaveLength(0);
    }),
  );

  it.effect("lists a page by offset, leaving comments out and not validating the query", () =>
    Effect.gen(function* () {
      const { tracker } = fakeDataCenter({
        "GET /user/search": () => [user("theo", "Theo")],
        "POST /search": ({ body }) => {
          expect(body).toMatchObject({ startAt: 4, maxResults: 2, validateQuery: false });
          expect(body?.["fields"]).not.toContain("comment");
          expect(body?.["jql"]).toBe(
            'project = "PROJ" AND statusCategory != Done AND assignee = "theo" ' +
              'AND (text ~ "7" OR key = "PROJ-7") ORDER BY updated DESC',
          );
          return {
            total: 10,
            issues: [
              issue("PROJ-2"),
              issue("PROJ-1", {
                status: status("Done", "done"),
                resolution: { name: "Fixed" },
                resolutiondate: "2026-07-03T08:00:00.000+0000",
                assignee: null,
              }),
            ],
          };
        },
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({
        ...listInput,
        assignee: "Theo",
        query: "7",
        cursor: "4",
      });
      expect(page.nextCursor).toBe("6");
      expect(page.items[0]).toEqual({
        key: "PROJ-2",
        displayKey: "PROJ-2",
        title: "Issue PROJ-2",
        url: `${SERVER}/browse/PROJ-2`,
        author: { login: "Julius", name: "Julius", avatarUrl: null },
        state: { category: "open", name: "In Progress" },
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-02T08:00:00.000Z",
        closedAt: null,
        assignees: [{ login: "Theo", name: "Theo", avatarUrl: null }],
        labels: [{ name: "bug", color: null }],
        commentCount: 0,
      });
      expect(page.items[1]).toMatchObject({
        state: { category: "closed", name: "Done" },
        closedAt: "2026-07-03T08:00:00.000Z",
        assignees: [],
      });
    }),
  );

  it.effect("ends the listing on the last page", () =>
    Effect.gen(function* () {
      const { tracker } = fakeDataCenter({
        "POST /search": () => ({ total: 1, issues: [issue("PROJ-1")] }),
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({ ...listInput, state: "all" });
      expect(page.nextCursor).toBeNull();
    }),
  );

  it.effect("reads an issue in markdown with its moves, changelog and comments", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({
        "GET /myself": () => user("julius", "Julius"),
        "GET /issue/PROJ-7": ({ query }) => {
          expect(query.get("expand")).toBe("transitions,changelog");
          return issue(
            "PROJ-7",
            {},
            {
              transitions: [
                { id: "31", name: "Finish", to: status("Done", "done") },
                { id: "11", name: "Back", to: status("To Do", "new") },
              ],
              changelog: {
                histories: [
                  {
                    id: "h1",
                    author: user("theo", "Theo"),
                    created: "2026-07-02T09:00:00.000+0000",
                    items: [
                      { field: "status", fromString: "In Progress", toString: "Done" },
                      { field: "resolution", fromString: null, toString: "Fixed" },
                      { field: "labels", fromString: "old bug", toString: "bug new" },
                      { field: "assignee", fromString: "Julius", toString: "Theo" },
                    ],
                  },
                ],
              },
            },
          );
        },
        "GET /issue/PROJ-7/comment": ({ query }) => {
          expect(query.get("orderBy")).toBe("-created");
          return {
            total: 51,
            comments: [
              {
                id: "c9",
                author: user("theo", "Theo"),
                created: "2026-07-02T11:00:00.000+0000",
                body: "See {{code}} and [docs|https://docs.test/a]",
              },
            ],
          };
        },
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "proj-7" });
      expect(detail).toMatchObject({
        key: "PROJ-7",
        body: "## Why\nIt is **broken**.",
        viewer: "Julius",
        commentCount: 51,
        commentsCursor: "1",
        states: [
          { category: "open", name: "To Do" },
          { category: "open", name: "In Progress" },
          { category: "closed", name: "Done" },
        ],
        // Data Center's permission keys differ, so every write is offered and Jira may refuse it.
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        comments: [
          {
            id: "c9",
            body: "See `code` and [docs](https://docs.test/a)",
            url: `${SERVER}/browse/PROJ-7?focusedCommentId=c9`,
          },
        ],
      });
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Done"],
        ["labeled", "new"],
        ["unlabeled", "old"],
        ["unassigned", "Julius"],
        ["assigned", "Theo"],
      ]);
      expect(requests.some((request) => request.route.includes("mypermissions"))).toBe(false);
    }),
  );

  it.effect(
    "moves an issue by a transition the transitions route offers, filling a resolution",
    () =>
      Effect.gen(function* () {
        const field = (required: boolean, name: string, allowedValues?: unknown) => ({
          required,
          name,
          hasDefaultValue: false,
          allowedValues,
        });
        const { tracker, requests } = fakeDataCenter({
          "GET /issue/PROJ-7": () => issue("PROJ-7"),
          "GET /issue/PROJ-7/transitions": ({ query }) => {
            expect(query.get("expand")).toBe("transitions.fields");
            return {
              transitions: [
                {
                  id: "31",
                  name: "Resolve",
                  to: status("Done", "done"),
                  fields: { resolution: field(true, "Resolution", [{ name: "Fixed" }, null, "x"]) },
                },
                {
                  id: "41",
                  name: "Close",
                  to: status("Closed", "done"),
                  fields: { fixVersions: field(true, "Fix versions") },
                },
              ],
            };
          },
          "POST /issue/PROJ-7/transitions": () => undefined,
        });
        const api = yield* tracker;
        yield* api.setState({ ...target, key: "PROJ-7", state: "Done" });
        expect(requests.at(-1)?.body).toEqual({
          transition: { id: "31" },
          fields: { resolution: { name: "Fixed" } },
        });

        const asked = yield* api
          .setState({ ...target, key: "PROJ-7", state: "Closed" })
          .pipe(Effect.flip);
        expect(asked.detail).toContain("asks for Fix versions");
        const refused = yield* api
          .setState({ ...target, key: "PROJ-7", state: "To Do" })
          .pipe(Effect.flip);
        expect(refused.detail).toBe(
          'This issue\'s workflow has no move to "To Do" from "In Progress".',
        );
      }),
  );

  it.effect("files and edits in wiki markup, addressing a person by login", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeDataCenter({
        "GET /issue/createmeta/PROJ/issuetypes": () => ({
          values: [
            { id: "5", name: "Sub-task", subtask: true },
            { id: "3", name: "Task" },
          ],
        }),
        "GET /user/assignable/search": ({ query }) => {
          expect(query.get("username")).toBe("");
          return [user("julius", "Julius"), user("theo", "Theo")];
        },
        "POST /issue": () => ({ id: "1", key: "PROJ-9" }),
        "GET /issue/PROJ-9": () => issue("PROJ-9"),
        "PUT /issue/PROJ-9": () => undefined,
        "POST /issue/PROJ-9/comment": () => ({ id: "c1" }),
      });
      const api = yield* tracker;
      const created = yield* api.create({
        ...target,
        title: "New",
        body: "## Plan\nSome **bold** text",
        labels: ["bug"],
        assignees: ["Theo"],
      });
      expect(created).toEqual({
        key: "PROJ-9",
        displayKey: "PROJ-9",
        url: `${SERVER}/browse/PROJ-9`,
      });
      expect(requests.at(-1)?.body).toEqual({
        fields: {
          project: { key: "PROJ" },
          issuetype: { id: "3" },
          summary: "New",
          description: "h2. Plan\nSome *bold* text",
          labels: ["bug"],
          assignee: { name: "theo" },
        },
      });

      yield* api.update({ ...target, key: "PROJ-9", body: "_hi_", assignees: [] });
      expect(requests.at(-1)?.body).toEqual({
        fields: { description: "_hi_", assignee: { name: null } },
      });

      yield* api.comment({ ...target, key: "PROJ-9", body: "`x`" });
      expect(requests.at(-1)?.body).toEqual({ body: "{{x}}" });
    }),
  );

  it.effect("offers assignable people by login and the labels Jira suggests", () =>
    Effect.gen(function* () {
      const { tracker } = fakeDataCenter({
        "GET /user/assignable/search": () => [user("theo", "Theo")],
        "GET /jql/autocompletedata/suggestions": () => ({ results: [{ value: "bug" }] }),
      });
      const api = yield* tracker;
      const candidates = yield* api.listCandidates({ ...target });
      expect(candidates).toEqual({
        labels: [{ name: "bug", color: null, description: null }],
        assignees: [{ login: "Theo", name: "Theo", avatarUrl: null, id: "theo" }],
        truncated: true,
      });
    }),
  );

  describe("refusals", () => {
    const read = (answer: Answer) =>
      Effect.gen(function* () {
        const { tracker } = fakeDataCenter({ "GET /myself": () => answer });
        const api = yield* tracker;
        return yield* api.getViewer({ ...target }).pipe(Effect.flip);
      });

    it.effect("reads a rejected token however Jira or a proxy in front of it says so", () =>
      Effect.gen(function* () {
        for (const answer of [
          new Response("", { status: 401 }),
          // Several reasons arrive as one comma-separated value.
          new Response("", {
            status: 403,
            headers: { "x-seraph-loginreason": "OUT, AUTHENTICATION_DENIED" },
          }),
          new Response("{}", { status: 200, headers: { "x-ausername": "anonymous" } }),
          new Response("<html>Log in</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          new Response("", { status: 302, headers: { location: "https://sso.corp/login" } }),
        ]) {
          expect((yield* read(answer)).reason).toBe("unauthenticated");
        }
      }),
    );

    it.effect("keeps a permission refusal, a missing issue and a rate limit apart", () =>
      Effect.gen(function* () {
        const forbidden = yield* read(
          Response.json({ errorMessages: ["You do not have the permission."] }, { status: 403 }),
        );
        expect(forbidden).toMatchObject({
          reason: "failed",
          detail: "You do not have the permission.",
        });
        const missing = yield* read(Response.json({ errorMessages: ["Gone"] }, { status: 404 }));
        expect(missing).toMatchObject({ reason: "not-found", detail: "Gone" });
        const limited = yield* read(
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
        );
        expect(limited.reason).toBe("rate-limited");
        expect(limited.retryAt).toBe(30_000);
      }),
    );

    it.effect("names where Jira moved to instead of following the redirect", () =>
      Effect.gen(function* () {
        const moved = yield* read(
          new Response("", {
            status: 301,
            headers: { location: "https://new.corp/jira/rest/api/2/myself" },
          }),
        );
        expect(moved.detail).toBe(
          "Jira moved to https://new.corp/jira. Connect with that address as the server URL.",
        );
      }),
    );

    it.effect("reports a response it cannot read as a failure", () =>
      Effect.gen(function* () {
        const unreadable = yield* read(new Response("not json", { status: 200 }));
        expect(unreadable.reason).toBe("failed");
      }),
    );
  });
});
