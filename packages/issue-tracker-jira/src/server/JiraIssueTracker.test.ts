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
      expect(probe).toEqual({ account: "Julius", scopes: [{ key: "ENG", name: "Engineering" }] });
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
          expect(query.get("fields")).toBe("*all,-comment,-worklog");
          expect(query.get("expand")).toBe("transitions,changelog,names,schema");
          return issue(
            "ENG-7",
            {
              description: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
              },
              project: { key: "ENG", name: "Engineering" },
              statuscategorychangedate: "2026-07-02T09:00:00.000+0000",
              customfield_10050: { value: "Hardware", child: { value: "Laptop" } },
              environment: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "Chrome", marks: [{ type: "strong" }] },
                      { type: "text", text: " 120" },
                    ],
                  },
                  { type: "paragraph", content: [{ type: "text", text: "macOS 15" }] },
                ],
              },
              customfield_10040: [{ value: "Gold" }, { value: "Silver" }],
              duedate: "2026-07-10",
              resolution: null,
              customfield_10016: 0,
              customfield_10020: [{ id: 12, name: "Sprint 12", state: "active", boardId: 1 }],
              fixVersions: [{ id: "100", name: "1.2", released: false }],
              components: [
                { id: "1", name: "API" },
                { id: "2", name: "Web" },
              ],
              issuetype: { id: "10001", name: "Bug", subtask: false },
              priority: { id: "2", name: "High", iconUrl: "https://acme.test/high.svg" },
              customfield_10041: THEO,
              customfield_10042: "2026-07-03T09:30:00.000+0000",
              customfield_10043: "",
              customfield_10044: { type: "doc", content: [{ type: "paragraph" }] },
              customfield_10045: [],
              customfield_10046: { votes: 2, hasVoted: false },
            },
            {
              names: {
                summary: "Summary",
                project: "Project",
                status: "Status",
                assignee: "Assignee",
                labels: "Labels",
                reporter: "Reporter",
                created: "Created",
                updated: "Updated",
                resolutiondate: "Resolved",
                priority: "Priority",
                issuetype: "Work type",
                components: "Components",
                fixVersions: "Fix versions",
                duedate: "Due date",
                resolution: "Resolution",
                environment: "Environment",
                customfield_10016: "Story point estimate",
                customfield_10020: "Sprint",
                customfield_10040: "Support tiers",
                customfield_10041: "Account manager",
                customfield_10042: "First response",
                customfield_10043: "Customer reference",
                customfield_10044: "Workaround",
                customfield_10045: "Affected teams",
                customfield_10046: "Ballot",
                customfield_10050: "Device",
              },
              schema: {
                customfield_10016: {
                  type: "number",
                  custom: "com.pyxis.greenhopper.jira:jsw-story-points",
                },
                customfield_10020: {
                  type: "array",
                  custom: "com.pyxis.greenhopper.jira:gh-sprint",
                },
                customfield_10042: {
                  type: "datetime",
                  custom: "com.atlassian.jira.plugin.system.customfieldtypes:datetime",
                },
              },
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
      // Under the site's names: the familiar fields first, Sprint and story points known by their
      // kind, then the rest by name. A value reads as Jira shows it; an empty one is unset.
      expect(detail.properties).toEqual([
        { id: "state", label: "Status", value: "In Progress" },
        { id: "assignees", label: "Assignee", value: ["Theo"] },
        { id: "labels", label: "Labels", value: ["bug"] },
        { id: "priority", label: "Priority", value: "High" },
        { id: "issuetype", label: "Work type", value: "Bug" },
        { id: "components", label: "Components", value: ["API", "Web"] },
        { id: "fixVersions", label: "Fix versions", value: ["1.2"] },
        { id: "customfield_10020", label: "Sprint", value: ["Sprint 12"] },
        { id: "customfield_10016", label: "Story point estimate", value: 0 },
        { id: "duedate", label: "Due date", value: "2026-07-10" },
        { id: "resolution", label: "Resolution", value: null },
        { id: "environment", label: "Environment", value: "Chrome 120\nmacOS 15" },
        { id: "customfield_10041", label: "Account manager", value: "Theo" },
        { id: "customfield_10045", label: "Affected teams", value: null },
        { id: "customfield_10046", label: "Ballot", value: { votes: 2, hasVoted: false } },
        { id: "customfield_10043", label: "Customer reference", value: null },
        { id: "customfield_10050", label: "Device", value: "Hardware / Laptop" },
        { id: "customfield_10042", label: "First response", value: "2026-07-03T09:30:00.000Z" },
        { id: "project", label: "Project", value: "Engineering" },
        { id: "customfield_10040", label: "Support tiers", value: ["Gold", "Silver"] },
        { id: "customfield_10044", label: "Workaround", value: null },
        { id: "author", label: "Reporter", value: "Julius" },
        { id: "createdAt", label: "Created", value: "2026-07-01T08:00:00.000Z" },
        { id: "updatedAt", label: "Updated", value: "2026-07-02T10:00:00.000Z" },
        { id: "closedAt", label: "Resolved", value: null },
      ]);
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
          issue("ENG-7", {}, { transitions: [{ id: "31", name: "Finish", to: DONE }] }),
        "POST /rest/api/3/issue/ENG-7/transitions": () => undefined,
      });
      const api = yield* tracker;
      yield* api.setState({ ...target, key: "ENG-7", state: "Done" });
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

  it.effect("reports Jira's own words for a refusal, and a rate limit with its wait", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
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
