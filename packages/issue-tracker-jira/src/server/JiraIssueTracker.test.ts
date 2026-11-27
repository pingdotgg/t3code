import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import type {
  IssueTrackerCredential,
  StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const STORED: IssueTrackerCredential = {
  token: "tok_stored",
  fields: { site: "acme", email: "julius@acme.test" },
};

const user = (accountId: string, displayName: string) => ({
  accountId,
  displayName,
  emailAddress: `${displayName.toLowerCase()}@acme.test`,
  avatarUrls: { "48x48": `https://avatars.test/${accountId}` },
});
const JULIUS = user("acc_julius", "Julius");
const THEO = user("acc_theo", "Theo");

const status = (name: string, category: string) => ({ name, statusCategory: { key: category } });
const TODO = status("To Do", "new");
const IN_PROGRESS = status("In Progress", "indeterminate");
const DONE = status("Done", "done");

const issue = (key: string, fields: Record<string, unknown> = {}, extra = {}) => ({
  id: `id_${key}`,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: IN_PROGRESS,
    project: { key: key.split("-")[0] },
    reporter: JULIUS,
    assignee: THEO,
    labels: ["bug"],
    created: "2026-07-01T10:00:00.000+0200",
    updated: "2026-07-02T10:00:00.000+0000",
    resolutiondate: null,
    ...fields,
  },
  ...extra,
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Answers each request by `METHOD /path`, the way the site would. */
function fakeJira(
  answers: Record<string, (seen: Seen) => unknown>,
  stored: IssueTrackerCredential | null = STORED,
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
          method: request.method,
          url: url.origin,
          path: url.pathname,
          query: url.searchParams,
          authorization: request.headers.authorization,
          body: body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : null,
        };
        requests.push(seen);
        const answer = answers[`${seen.method} ${seen.path}`];
        const answered = answer?.(seen);
        const response =
          answered instanceof Response
            ? answered
            : answer === undefined
              ? Response.json({ errorMessages: [`No answer for ${seen.path}`] }, { status: 400 })
              : answered === undefined
                ? new Response(null, { status: 204 })
                : Response.json(answered);
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeed(Option.fromNullishOr(stored)) },
    }),
  );
  // Every write this tracker declares is implemented; the type says so for the calls below.
  const tracker = JiraIssueTracker.make.pipe(
    Effect.map(
      (api) =>
        api as StandaloneIssueTrackerApi &
          Required<Pick<StandaloneIssueTrackerApi, "create" | "comment" | "update" | "setState">>,
    ),
    Effect.provide(JiraApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "atlassian.net", scope: "ENG" };
const listInput = {
  ...target,
  state: "open",
  involvement: "all",
  viewer: "Julius",
  limit: 30,
  sort: "updated",
} as const;

describe("JiraIssueTracker", () => {
  it.effect("vets a credential against its own site before anything is stored", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira(
        {
          "GET /rest/api/3/myself": () => JULIUS,
          "GET /rest/api/3/project/search": () => ({
            values: [{ key: "ENG", name: "Engineering" }],
          }),
        },
        null,
      );
      const api = yield* tracker;
      const probe = yield* api.probeCredential({
        token: "tok_new",
        fields: { site: "https://other.atlassian.net/jira/software", email: "j@acme.test" },
      });
      expect(probe).toEqual({
        account: "Julius",
        workspace: "other.atlassian.net",
        scopes: [{ key: "ENG", name: "Engineering" }],
      });
      expect(new Set(requests.map((request) => request.url))).toEqual(
        new Set(["https://other.atlassian.net"]),
      );
      expect(requests[0]?.authorization).toBe(`Basic ${btoa("j@acme.test:tok_new")}`);

      const refused = yield* api
        .probeCredential({ token: "t", fields: { site: "http://plain.test", email: "j@a.test" } })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("unauthenticated");
    }),
  );

  it.effect("lists a project's issues with every filter in the query", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
        "GET /rest/api/3/user/search": () => [user("acc_other", "Theodore"), THEO],
        "POST /rest/api/3/search/jql": ({ body }) => {
          expect(body).toMatchObject({
            jql:
              'project = "ENG" AND statusCategory != Done AND assignee = currentUser() ' +
              'AND assignee = "acc_theo" AND labels = "bug" ' +
              'AND (text ~ "12" OR key = "ENG-12") ORDER BY created DESC',
            maxResults: 30,
            nextPageToken: "page2",
          });
          return {
            issues: [
              issue("ENG-2", { status: DONE, resolutiondate: "2026-07-03T00:00:00.000+0000" }),
            ],
            nextPageToken: "page3",
          };
        },
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({
        ...listInput,
        involvement: "assigned",
        assignee: "Theo",
        labels: ["bug"],
        query: "12",
        sort: "created",
        cursor: "page2",
      });
      expect(page.nextCursor).toBe("page3");
      expect(page.items).toEqual([
        {
          key: "ENG-2",
          displayKey: "ENG-2",
          title: "Issue ENG-2",
          url: "https://acme.atlassian.net/browse/ENG-2",
          author: { login: "Julius", name: "Julius", avatarUrl: "https://avatars.test/acc_julius" },
          state: { category: "closed", name: "Done" },
          createdAt: "2026-07-01T08:00:00.000Z",
          updatedAt: "2026-07-02T10:00:00.000Z",
          closedAt: "2026-07-03T00:00:00.000Z",
          assignees: [{ login: "Theo", name: "Theo", avatarUrl: "https://avatars.test/acc_theo" }],
          labels: [{ name: "bug", color: null }],
          commentCount: 0,
        },
      ]);
    }),
  );

  it.effect("searches by text alone when the number names no issue", () =>
    Effect.gen(function* () {
      const queries: string[] = [];
      const { tracker } = fakeJira({
        "POST /rest/api/3/search/jql": ({ body }) => {
          const { jql } = body as { jql: string };
          queries.push(jql);
          return jql.includes("key =")
            ? Response.json(
                { errorMessages: ["An issue with key 'ENG-404' does not exist."] },
                { status: 400 },
              )
            : { issues: [] };
        },
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({ ...listInput, state: "all", query: "#404" });
      expect(page).toEqual({ items: [], nextCursor: null });
      expect(queries.at(-1)).toBe('project = "ENG" AND text ~ "#404" ORDER BY updated DESC');
    }),
  );

  it.effect("reads an issue with the moves its workflow offers and what the account may do", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
        "GET /rest/api/3/myself": () => JULIUS,
        "GET /rest/api/3/issue/ENG-7": ({ query }) => {
          expect(query.get("expand")).toBe("transitions,changelog");
          return issue(
            "ENG-7",
            {
              description: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
              },
            },
            {
              transitions: [
                { id: "31", name: "Finish", to: DONE },
                { id: "11", name: "Back", to: TODO },
              ],
              changelog: {
                histories: [
                  {
                    id: "h1",
                    author: THEO,
                    created: "2026-07-02T09:00:00.000+0000",
                    items: [
                      { field: "status", fromString: "Done", toString: "In Progress" },
                      { field: "resolution", fromString: "Done", toString: null },
                      { field: "labels", fromString: "old bug", toString: "bug new" },
                      { field: "assignee", fromString: "Julius", toString: "Theo" },
                      { field: "summary", fromString: "Was", toString: "Issue ENG-7" },
                      { field: "Rank", fromString: "", toString: "Ranked higher" },
                    ],
                  },
                ],
              },
            },
          );
        },
        "GET /rest/api/3/issue/ENG-7/comment": ({ query }) => {
          expect(query.get("orderBy")).toBe("-created");
          return {
            total: 51,
            comments: [
              {
                id: "c9",
                author: THEO,
                created: "2026-07-02T11:00:00.000+0000",
                body: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
                },
              },
            ],
          };
        },
        "GET /rest/api/3/mypermissions": ({ query }) => {
          expect(query.get("issueKey")).toBe("ENG-7");
          return {
            permissions: {
              TRANSITION_ISSUES: { havePermission: true },
              ADD_COMMENTS: { havePermission: true },
              EDIT_ISSUES: { havePermission: false },
              ASSIGN_ISSUES: { havePermission: true },
            },
          };
        },
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-7" });
      expect(detail).toMatchObject({
        key: "ENG-7",
        body: "Body",
        viewer: "Julius",
        commentCount: 51,
        commentsCursor: "1",
        state: { category: "open", name: "In Progress" },
        // The current status sits among the ones it can move to, in board order.
        states: [
          { category: "open", name: "To Do" },
          { category: "open", name: "In Progress" },
          { category: "closed", name: "Done" },
        ],
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: false,
          labels: false,
          assignees: true,
        },
        comments: [
          {
            id: "c9",
            body: "Hi",
            url: "https://acme.atlassian.net/browse/ENG-7?focusedCommentId=c9",
          },
        ],
      });
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["reopened", "In Progress"],
        ["labeled", "new"],
        ["unlabeled", "old"],
        ["unassigned", "Julius"],
        ["assigned", "Theo"],
        ["renamed", "Issue ENG-7"],
      ]);
    }),
  );

  it.effect("moves an issue by the transition that leads to the named status", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/issue/ENG-7": () =>
          issue(
            "ENG-7",
            {},
            {
              transitions: [
                { id: "31", name: "Finish", to: DONE },
                { id: "41", name: "Cancel", to: DONE },
              ],
            },
          ),
        "POST /rest/api/3/issue/ENG-7/transitions": () => undefined,
      });
      const api = yield* tracker;
      // Two moves reach Done, so the status alone does not say which runs.
      const ambiguous = yield* api
        .setState({ ...target, key: "ENG-7", state: "Done" })
        .pipe(Effect.flip);
      expect(ambiguous.detail).toContain('"Finish", "Cancel"');
      yield* api.setState({ ...target, key: "ENG-7", state: "Finish" });
      expect(requests.at(-1)?.body).toEqual({ transition: { id: "31" } });

      const refused = yield* api
        .setState({ ...target, key: "ENG-7", state: "To Do" })
        .pipe(Effect.flip);
      expect(refused.detail).toBe(
        'This issue\'s workflow has no move to "To Do" from "In Progress".',
      );
      // A key from another project is refused before Jira is asked anything.
      const before = requests.length;
      const foreign = yield* api
        .setState({ ...target, key: "OPS-1", state: "Done" })
        .pipe(Effect.flip);
      expect(foreign.detail).toBe("OPS-1 does not belong to Jira project ENG.");
      expect(requests).toHaveLength(before);
    }),
  );

  it.effect("files an issue as a Task with names turned into what Jira addresses", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/issue/createmeta/ENG/issuetypes": () => ({
          issueTypes: [
            { id: "5", name: "Sub-task", subtask: true },
            { id: "1", name: "Bug" },
            { id: "3", name: "Task" },
          ],
        }),
        "GET /rest/api/3/user/assignable/search": () => [JULIUS, THEO],
        "POST /rest/api/3/issue": () => ({ id: "1", key: "ENG-9" }),
      });
      const api = yield* tracker;
      const created = yield* api.create({
        ...target,
        title: "New",
        body: "Hello",
        labels: ["bug"],
        assignees: ["theo@acme.test"],
      });
      expect(created).toEqual({
        key: "ENG-9",
        displayKey: "ENG-9",
        url: "https://acme.atlassian.net/browse/ENG-9",
      });
      expect(requests.at(-1)?.body).toEqual({
        fields: {
          project: { key: "ENG" },
          issuetype: { id: "3" },
          summary: "New",
          description: {
            version: 1,
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
          },
          labels: ["bug"],
          assignee: { accountId: "acc_theo" },
        },
      });
    }),
  );

  it.effect("assigns a person a search found after an empty assignable page", () =>
    Effect.gen(function* () {
      const JORDAN = user("acc_jordan", "Jordan");
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/label": () => ({ values: ["bug"] }),
        "GET /rest/api/3/issue/createmeta/ENG/issuetypes": () => ({
          issueTypes: [{ id: "3", name: "Task" }],
        }),
        "GET /rest/api/3/user/assignable/search": ({ query }) =>
          query.get("query") === "jordan@acme.test" || query.get("accountId") === "acc_jordan"
            ? query.get("startAt") === "0"
              ? [JORDAN]
              : []
            : query.get("startAt") === "0"
              ? [THEO]
              : [],
        "GET /rest/api/3/user/search": () => [],
        "POST /rest/api/3/issue": () => ({ id: "1", key: "ENG-9" }),
      });
      const api = yield* tracker;
      expect(yield* api.listCandidates!(target)).toMatchObject({ assigneeSearch: true });
      expect(yield* api.listCandidates!({ ...target, query: "jordan@acme.test" })).toMatchObject({
        labels: [],
        assignees: [{ login: "Jordan", id: "acc_jordan" }],
      });
      yield* api.create({
        ...target,
        title: "New",
        body: "",
        labels: [],
        assignees: ["acc_jordan"],
      });
      expect(requests.at(-1)?.body).toMatchObject({
        fields: { assignee: { accountId: "acc_jordan" } },
      });
    }),
  );

  it.effect("refuses to rewrite a description markdown would lose part of", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /rest/api/3/issue/ENG-7": () =>
          issue("ENG-7", {
            description: { type: "doc", content: [{ type: "mediaSingle", content: [] }] },
          }),
        "PUT /rest/api/3/issue/ENG-7": () => undefined,
      });
      const api = yield* tracker;
      const refused = yield* api.update({ ...target, key: "ENG-7", body: "new" }).pipe(Effect.flip);
      expect(refused.detail).toContain("Edit it in Jira");
      // The title and an emptied assignee still go through, without reading the issue first.
      yield* api.update({ ...target, key: "ENG-7", title: "Renamed", assignees: [] });
      expect(requests.at(-1)).toMatchObject({
        method: "PUT",
        body: { fields: { summary: "Renamed", assignee: null } },
      });
    }),
  );

  // https://github.com/pingdotgg/t3code/pull/38003#issuecomment-7101618257
  it.effect(
    "posts a service desk comment as an internal note unless it replies to the customer",
    () =>
      Effect.gen(function* () {
        const { tracker, requests } = fakeJira({
          "GET /rest/api/3/issue/HELP-3": () =>
            issue("HELP-3", { project: { key: "HELP", projectTypeKey: "service_desk" } }),
          "POST /rest/api/3/issue/HELP-3/comment": () => ({}),
        });
        const api = yield* tracker;
        const help = { ...target, scope: "HELP", key: "HELP-3" };
        yield* api.comment({ ...help, body: "Looking" });
        expect(requests.at(-1)?.body).toMatchObject({
          properties: [{ key: "sd.public.comment", value: { internal: true } }],
        });
        yield* api.comment({ ...help, body: "Fixed", audience: "public" });
        expect(requests.at(-1)?.body).toMatchObject({
          properties: [{ key: "sd.public.comment", value: { internal: false } }],
        });
      }),
  );

  it.effect("reports Jira's own words for a refusal, and a rate limit with its wait", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
        "GET /rest/api/3/issue/ENG-7": () => issue("ENG-7"),
        "POST /rest/api/3/issue/ENG-7/comment": () =>
          Response.json({ errors: { comment: "Comment body can not be empty!" } }, { status: 400 }),
        "POST /rest/api/3/search/jql": () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
      });
      const api = yield* tracker;
      const refused = yield* api.comment({ ...target, key: "ENG-7", body: "x" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ reason: "failed", detail: "Comment body can not be empty!" });
      const limited = yield* api.listIssues(listInput).pipe(Effect.flip);
      expect(limited.reason).toBe("rate-limited");
      expect(limited.retryAt).toBe(30_000);
    }),
  );
});
