import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const STORED = JSON.stringify({ site: "acme", email: "julius@acme.test", token: "tok" });

const user = (accountId: string, displayName: string) => ({
  accountId,
  displayName,
  avatarUrls: { "48x48": `https://avatar.test/${accountId}` },
});
const JULIUS = user("5b10a2844c20165700ede21g", "Julius");
const THEO = user("5b10ac8d82e05b22cc7d4ef5", "Theo");

const status = (name: string, category: "new" | "indeterminate" | "done") => ({
  id: `st_${name}`,
  name,
  statusCategory: { key: category },
});

const issue = (key: string, overrides: Record<string, unknown> = {}) => ({
  id: `id_${key}`,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: status("In Progress", "indeterminate"),
    created: "2026-07-01T10:00:00.000+0000",
    updated: "2026-07-02T10:00:00.000+0000",
    resolutiondate: null,
    reporter: JULIUS,
    assignee: THEO,
    labels: ["bug"],
    project: { key: key.split("-")[0] },
    ...overrides,
  },
});

const doc = (...content: ReadonlyArray<unknown>) => ({ type: "doc", version: 1, content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

/** Answers each request by `METHOD /path` under the REST API root, the way Jira Cloud would. */
function fakeJira(
  answers: Record<string, (seen: Seen) => unknown>,
  stored: string | null = STORED,
) {
  const requests: Seen[] = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const body = request.body;
        const seen: Seen = {
          method: request.method,
          path: url.pathname.replace("/rest/api/3", ""),
          params: new URLSearchParams(UrlParams.toString(request.urlParams)),
          body:
            body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(body.body))
              : undefined,
          authorization: request.headers.authorization,
        };
        expect(url.origin).toBe("https://acme.atlassian.net");
        requests.push(seen);
        const answer = answers[`${seen.method} ${seen.path}`];
        const answered = answer?.(seen);
        const response =
          answered instanceof Response
            ? answered
            : answer === undefined
              ? new Response(JSON.stringify({ errorMessages: [`No answer for ${seen.path}`] }), {
                  status: 400,
                  headers: { "content-type": "application/json" },
                })
              : answered === undefined
                ? new Response(null, { status: 204 })
                : new Response(JSON.stringify(answered), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                  });
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
  // Every optional write that Jira supports is implemented; the type says so for the calls below.
  const tracker = JiraIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(JiraApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "atlassian.net", scope: "ENG" };

describe("JiraIssueTracker", () => {
  it.effect("parses Jira Cloud issue links with their site and project", () =>
    Effect.gen(function* () {
      const api = yield* fakeJira({}).tracker;
      for (const suffix of ["", "/", "?focusedCommentId=10#comment"]) {
        expect(
          api.parseIssueUrl(new URL(`https://acme.atlassian.net/browse/ENG-12${suffix}`)),
        ).toEqual({
          host: "atlassian.net",
          workspace: "acme",
          scope: "ENG",
          key: "ENG-12",
        });
      }
      for (const url of [
        "http://acme.atlassian.net/browse/ENG-12",
        "https://acme.atlassian.net:444/browse/ENG-12",
        "https://atlassian.net/browse/ENG-12",
        "https://acme.atlassian.net.evil.test/browse/ENG-12",
        "https://acme.atlassian.net/browse/eng-12",
        "https://acme.atlassian.net/browse/ENG-0",
        "https://acme.atlassian.net/browse/ENG-12/extra",
        "https://acme.atlassian.net/jira/software/projects/ENG/boards/1",
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toBeNull();
      }
    }),
  );

  it.effect("vets a credential before it is stored, against its own site only", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira(
        {
          "GET /myself": () => JULIUS,
          // A site's projects arrive in pages; every page is read.
          "GET /project/search": (seen) =>
            seen.params.get("startAt") === "0"
              ? { isLast: false, values: [{ id: "1", key: "ENG", name: "Engineering" }] }
              : { isLast: true, values: [{ id: "2", key: "OPS", name: "Operations" }] },
        },
        null,
      );
      const api = yield* tracker;
      expect(api.kind).toBe(IssueTrackerKind.make("jira"));
      expect(api.standalone).toMatchObject({ host: "atlassian.net", scopeNoun: "project" });
      const probe = yield* api.probeCredential(
        JSON.stringify({
          site: "https://ACME.atlassian.net/",
          email: " julius@acme.test ",
          token: "tok",
        }),
      );
      expect(probe).toEqual({
        account: "Julius",
        workspace: "acme",
        scopes: [
          { key: "ENG", name: "Engineering" },
          { key: "OPS", name: "Operations" },
        ],
      });
      expect(requests[0]?.authorization).toBe(`Basic ${btoa("julius@acme.test:tok")}`);
      // A site that is not a Jira Cloud subdomain is never asked anything.
      for (const site of ["evil.test", "acme.atlassian.net.evil.test", "acme/../x"]) {
        const refused = yield* Effect.flip(
          api.probeCredential(JSON.stringify({ site, email: "a@b.c", token: "t" })),
        );
        expect(refused.reason).toBe("unauthenticated");
      }
      const notConnected = yield* Effect.flip(api.getViewer({ cwd: "", host: "atlassian.net" }));
      expect(notConnected.reason).toBe("unauthenticated");
      expect(requests).toHaveLength(3);
    }),
  );

  it.effect("lists a project's issues with JQL built from the filters", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /user/assignable/search": () => [THEO],
        "POST /search/jql": () => ({
          issues: [
            issue("ENG-2", {
              status: status("Done", "done"),
              resolutiondate: "2026-07-03T10:00:00.000+0000",
            }),
            issue("ENG-1"),
          ],
          nextPageToken: "tok_2",
        }),
      });
      const api = yield* tracker;
      const page = yield* api.listIssues({
        ...target,
        involvement: "assigned",
        viewer: "Julius",
        state: "open",
        limit: 25,
        query: 'say "hi" \\ 12',
        labels: ["bug"],
        assignee: "Theo",
        sort: "created",
      });
      const search = requests.find((request) => request.path === "/search/jql");
      expect(search?.body).toMatchObject({
        jql:
          'project = "ENG" AND statusCategory != Done AND assignee = currentUser() AND ' +
          `assignee = "${THEO.accountId}" AND labels = "bug" AND text ~ "say \\"hi\\" \\\\ 12" ` +
          "ORDER BY created DESC",
        maxResults: 25,
      });
      expect(page.nextCursor).toBe("tok_2");
      expect(page.items[0]).toMatchObject({
        key: "ENG-2",
        displayKey: "ENG-2",
        url: "https://acme.atlassian.net/browse/ENG-2",
        state: { category: "closed", name: "Done", closeReason: "completed" },
        closedAt: "2026-07-03T10:00:00.000Z",
        author: { login: "Julius", name: "Julius" },
        assignees: [{ login: "Theo" }],
        labels: [{ name: "bug", color: null }],
      });
      expect(page.items[1]?.closedAt).toBeNull();

      // A bare number also finds the issue by key; the cursor carries on.
      yield* api.listIssues({
        ...target,
        involvement: "all",
        state: "all",
        limit: 10,
        query: "#7",
        sort: "updated",
        cursor: "tok_2",
      });
      expect(requests.at(-1)?.body).toEqual(
        expect.objectContaining({
          jql: 'project = "ENG" AND (text ~ "#7" OR key = "ENG-7") ORDER BY updated DESC',
          nextPageToken: "tok_2",
        }),
      );
      const refused = yield* Effect.flip(
        api.listIssues({
          ...target,
          scope: 'ENG" OR project = "OPS',
          involvement: "all",
          state: "all",
          limit: 1,
          sort: "updated",
        }),
      );
      expect(refused.detail).toContain("not a Jira project key");
    }),
  );

  it.effect("reads an issue with its newest comments oldest first, its history and its moves", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /myself": () => JULIUS,
        "GET /issue/ENG-1": () => ({
          ...issue("ENG-1", {
            description: doc(
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("Open it")] }],
              },
            ),
          }),
          changelog: {
            histories: [
              {
                id: "100",
                author: THEO,
                created: "2026-07-01T11:00:00.000+0000",
                items: [
                  { field: "status", fromString: "To Do", toString: "In Progress" },
                  { field: "labels", fromString: "old", toString: "bug ui" },
                  { field: "assignee", fromString: null, toString: "Theo" },
                  { field: "Sprint", fromString: null, toString: "Sprint 4" },
                ],
              },
            ],
          },
          transitions: [
            { id: "31", to: status("Done", "done") },
            { id: "11", to: status("To Do", "new") },
            { id: "21", to: status("In Progress", "indeterminate") },
          ],
        }),
        "GET /issue/ENG-1/comment": (seen) => {
          expect(seen.params.get("orderBy")).toBe("-created");
          return {
            startAt: Number(seen.params.get("startAt")),
            total: 51,
            comments: [
              {
                id: "c2",
                author: THEO,
                body: doc(paragraph("newest")),
                created: "2026-07-02T09:00:00.000+0000",
              },
              {
                id: "c1",
                author: JULIUS,
                body: doc(paragraph("older")),
                created: "2026-07-01T09:00:00.000+0000",
              },
            ],
          };
        },
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-1" });
      expect(detail).toMatchObject({
        key: "ENG-1",
        body: "## Steps\n\n- Open it",
        viewer: "Julius",
        commentCount: 51,
        linkedPullRequests: [],
      });
      expect(detail.comments.map((comment) => [comment.id, comment.body])).toEqual([
        ["c1", "older"],
        ["c2", "newest"],
      ]);
      expect(detail.comments[0]?.url).toBe(
        "https://acme.atlassian.net/browse/ENG-1?focusedCommentId=c1",
      );
      expect(detail.commentsCursor).toBe("2");
      expect(detail.states.map((state) => [state.name, state.category])).toEqual([
        ["In Progress", "open"],
        ["Done", "closed"],
        ["To Do", "open"],
      ]);
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["state-changed", "In Progress"],
        ["labeled", "bug"],
        ["labeled", "ui"],
        ["unlabeled", "old"],
        ["assigned", "Theo"],
      ]);

      const older = yield* api.getComments({ ...target, key: "ENG-1", cursor: "2" });
      expect(requests.at(-1)?.params.get("startAt")).toBe("2");
      expect(older.nextCursor).toBe("4");
      const bad = yield* Effect.flip(api.getComments({ ...target, key: "ENG-1", cursor: "x" }));
      expect(bad.detail).toContain("cursor");
    }),
  );

  it.effect("writes only to issues in the bound project, as Markdown turned into ADF", () =>
    Effect.gen(function* () {
      const writes: Seen[] = [];
      const { tracker } = fakeJira({
        "GET /issue/ENG-1": () => ({
          ...issue("ENG-1"),
          transitions: [{ id: "31", to: status("Done", "done") }],
        }),
        "GET /issue/OPS-3": () => issue("OPS-3"),
        "GET /issue/ENG-5": () =>
          issue("ENG-5", {
            description: doc({
              type: "mediaSingle",
              content: [{ type: "media", attrs: { id: "m" } }],
            }),
          }),
        "GET /issue/ENG-9": () =>
          new Response(JSON.stringify({ errorMessages: ["Issue does not exist"] }), {
            status: 404,
          }),
        "PUT /issue/ENG-1": (seen) => void writes.push(seen),
        "PUT /issue/ENG-5": (seen) => void writes.push(seen),
        "POST /issue/ENG-1/comment": (seen) => void writes.push(seen),
        "POST /issue/ENG-1/transitions": (seen) => void writes.push(seen),
        "GET /user/assignable/search": () => [THEO, user("5b10ac8d82e05b22cc7d4ef6", "Theo")],
      });
      const api = yield* tracker;
      // A key from another project resolves in Jira, so the project is checked before writing.
      const foreign = yield* Effect.flip(api.comment({ ...target, key: "OPS-3", body: "hi" }));
      expect(foreign.detail).toContain("OPS");
      const missing = yield* Effect.flip(api.comment({ ...target, key: "ENG-9", body: "hi" }));
      expect(missing.reason).toBe("not-found");

      yield* api.comment({ ...target, key: "ENG-1", body: "**Done** in `main`" });
      yield* api.update({
        ...target,
        key: "ENG-1",
        title: "Renamed",
        body: "",
        labels: ["bug", "ui"],
        assignees: [THEO.accountId],
      });
      yield* api.setState({ ...target, key: "ENG-1", state: "Done" });
      const unknown = yield* Effect.flip(
        api.setState({ ...target, key: "ENG-1", state: "closed" }),
      );
      expect(unknown.detail).toContain('to "closed"');
      // Its attachment would not survive the Markdown round trip, so the body is not rewritten.
      const attached = yield* Effect.flip(api.update({ ...target, key: "ENG-5", body: "new" }));
      expect(attached.detail).toContain("Edit it in Jira");
      yield* api.update({ ...target, key: "ENG-5", title: "Still renamable" });
      const spaced = yield* Effect.flip(
        api.update({ ...target, key: "ENG-1", labels: ["two words"] }),
      );
      expect(spaced.detail).toContain("spaces");
      const two = yield* Effect.flip(
        api.update({ ...target, key: "ENG-1", assignees: ["a", "b"] }),
      );
      expect(two.detail).toContain("one assignee");
      const ambiguous = yield* Effect.flip(
        api.update({ ...target, key: "ENG-1", assignees: ["Theo"] }),
      );
      expect(ambiguous.detail).toContain("More than one");

      expect(writes.map((write) => [write.method, write.path, write.body])).toEqual([
        [
          "POST",
          "/issue/ENG-1/comment",
          {
            body: doc({
              type: "paragraph",
              content: [
                { type: "text", text: "Done", marks: [{ type: "strong" }] },
                { type: "text", text: " in " },
                { type: "text", text: "main", marks: [{ type: "code" }] },
              ],
            }),
          },
        ],
        [
          "PUT",
          "/issue/ENG-1",
          {
            fields: {
              summary: "Renamed",
              description: null,
              labels: ["bug", "ui"],
              assignee: { accountId: THEO.accountId },
            },
          },
        ],
        ["POST", "/issue/ENG-1/transitions", { transition: { id: "31" } }],
        ["PUT", "/issue/ENG-5", { fields: { summary: "Still renamable" } }],
      ]);
    }),
  );

  it.effect("files a new issue under the project's first standard issue type", () =>
    Effect.gen(function* () {
      let created: unknown;
      const { tracker } = fakeJira({
        "GET /issue/createmeta/ENG/issuetypes": () => ({
          issueTypes: [
            { id: "5", name: "Sub-task", subtask: true },
            { id: "10001", name: "Task", subtask: false },
          ],
        }),
        "POST /issue": (seen) => {
          created = seen.body;
          return { id: "100", key: "ENG-42" };
        },
      });
      const api = yield* tracker;
      const result = yield* api.create({
        ...target,
        title: "New",
        body: "- [ ] first",
        labels: [],
        assignees: [],
      });
      expect(result).toEqual({
        key: "ENG-42",
        displayKey: "ENG-42",
        url: "https://acme.atlassian.net/browse/ENG-42",
      });
      expect(created).toEqual({
        fields: {
          project: { key: "ENG" },
          issuetype: { id: "10001" },
          summary: "New",
          description: doc({
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "[ ] " },
                      { type: "text", text: "first" },
                    ],
                  },
                ],
              },
            ],
          }),
        },
      });
    }),
  );

  it.effect("maps Jira's refusals to the tracker's failure reasons", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
        "GET /myself": () => new Response("", { status: 401 }),
        "POST /search/jql": () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
        "GET /issue/createmeta/ENG/issuetypes": () =>
          new Response(JSON.stringify({ errors: { project: "You cannot create issues here." } }), {
            status: 403,
          }),
      });
      const api = yield* tracker;
      const unauthenticated = yield* Effect.flip(api.getViewer({ cwd: "", host: "atlassian.net" }));
      expect(unauthenticated.reason).toBe("unauthenticated");
      const limited = yield* Effect.flip(
        api.listIssues({ ...target, involvement: "all", state: "all", limit: 1, sort: "updated" }),
      );
      expect(limited.reason).toBe("rate-limited");
      expect(limited.retryAt).toBeGreaterThan(0);
      const refused = yield* Effect.flip(
        api.create({ ...target, title: "x", body: "", labels: [], assignees: [] }),
      );
      expect(refused.detail).toBe("You cannot create issues here.");
    }),
  );
});
