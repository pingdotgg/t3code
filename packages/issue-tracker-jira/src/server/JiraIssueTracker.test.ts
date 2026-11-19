import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as JiraApi from "./JiraApi.ts";
import * as JiraIssueTracker from "./JiraIssueTracker.ts";

const STORED = JSON.stringify({ site: "acme", email: "julius@acme.test", token: "tok" });

const user = (accountId: string, displayName: string) => ({ accountId, displayName });
const JULIUS = user("5b10a2844c20165700ede21g", "Julius");
const THEO = user("5b10ac8d82e05b22cc7d4ef5", "Theo");

const status = (name: string, category: "indeterminate" | "done") => ({
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
  it.effect("parses only Jira Cloud issue links", () =>
    Effect.gen(function* () {
      const api = yield* fakeJira({}).tracker;
      expect(
        api.parseIssueUrl(new URL("https://acme.atlassian.net/browse/ENG-12?focusedCommentId=1")),
      ).toEqual({ host: "atlassian.net", workspace: "acme", scope: "ENG", key: "ENG-12" });
      for (const url of [
        "https://acme.atlassian.net:444/browse/ENG-12",
        "https://acme.atlassian.net.evil.test/browse/ENG-12",
        "https://acme.atlassian.net/browse/ENG-12/extra",
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toBeNull();
      }
    }),
  );

  it.effect("vets a credential against its own site, reading every project page", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira(
        {
          "GET /myself": () => JULIUS,
          "GET /project/search": (seen) =>
            seen.params.get("startAt") === "0"
              ? { isLast: false, values: [{ id: "1", key: "ENG", name: "Engineering" }] }
              : { isLast: true, values: [{ id: "2", key: "OPS", name: "Operations" }] },
        },
        null,
      );
      const api = yield* tracker;
      const probe = yield* api.probeCredential(
        JSON.stringify({
          site: "https://ACME.atlassian.net/",
          email: "julius@acme.test",
          token: "t",
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
      expect(requests[0]?.authorization).toBe(`Basic ${btoa("julius@acme.test:t")}`);
      // A site that is not a Jira Cloud subdomain is never asked anything.
      const refused = yield* Effect.flip(
        api.probeCredential(JSON.stringify({ site: "acme/../x", email: "a@b.c", token: "t" })),
      );
      expect(refused.reason).toBe("unauthenticated");
      expect(requests).toHaveLength(3);
      const { tracker: missing } = fakeJira(
        { "GET /myself": () => new Response("", { status: 404 }) },
        null,
      );
      const unknownSite = yield* Effect.flip(
        (yield* missing).probeCredential(
          JSON.stringify({ site: "acme", email: "a@b.c", token: "t" }),
        ),
      );
      expect(unknownSite.detail).toBe("acme.atlassian.net is not a Jira site.");
    }),
  );

  it.effect("lists a project's issues with JQL built from the filters", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /user/assignable/search": () => [THEO],
        "POST /search/jql": () => ({
          issues: [issue("ENG-2", { status: status("Done", "done") })],
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
        query: 'say "hi" 7',
        assignee: "Theo",
        sort: "created",
      });
      expect(requests.at(-1)?.body).toMatchObject({
        jql:
          'project = "ENG" AND statusCategory != Done AND assignee = currentUser() AND ' +
          `assignee = "${THEO.accountId}" AND text ~ "say \\"hi\\" 7" ORDER BY created DESC`,
      });
      expect(page.nextCursor).toBe("tok_2");
      expect(page.items[0]?.state).toMatchObject({ category: "closed", name: "Done" });
      const injected = yield* Effect.flip(
        api.listIssues({
          ...target,
          scope: 'ENG" OR project = "OPS',
          involvement: "all",
          state: "all",
          limit: 1,
          sort: "updated",
        }),
      );
      expect(injected.detail).toContain("not a Jira project key");
    }),
  );

  it.effect("reads an issue with its newest comments oldest first, its history and its moves", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeJira({
        "GET /myself": () => JULIUS,
        "GET /issue/ENG-1": () => ({
          ...issue("ENG-1", { description: doc(paragraph("Steps")) }),
          changelog: {
            histories: [
              {
                id: "100",
                author: THEO,
                created: "2026-07-01T11:00:00.000+0000",
                items: [
                  { field: "status", fromString: "To Do", toString: "In Progress" },
                  { field: "labels", fromString: "old", toString: "bug" },
                ],
              },
            ],
          },
          transitions: [{ id: "31", to: status("Done", "done") }],
        }),
        "GET /issue/ENG-1/comment": (seen) => {
          const startAt = Number(seen.params.get("startAt"));
          const comment = (n: number) => ({
            id: `c${n}`,
            author: THEO,
            body: doc(paragraph(`comment ${n}`)),
            created: "2026-07-02T09:00:00.000+0000",
          });
          return { startAt, total: 51, comments: [comment(startAt + 2), comment(startAt + 1)] };
        },
        "GET /rest/dev-status/latest/issue/summary": () => ({
          summary: {
            pullrequest: {
              byInstanceType: { GitHub: { count: 1 }, GitLab: { count: 1 }, stash: { count: 0 } },
            },
          },
        }),
        "GET /rest/dev-status/latest/issue/detail": (seen) => {
          expect(seen.params.get("applicationType")).not.toBe("stash");
          if (seen.params.get("applicationType") === "GitLab")
            return new Response("", { status: 403 });
          const pull = { name: "Fix", url: "https://github.com/acme/web/pull/7", status: "MERGED" };
          return { detail: [{ pullRequests: [pull, pull] }] };
        },
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-1" });
      expect(detail).toMatchObject({ key: "ENG-1", body: "Steps", viewer: "Julius" });
      expect(detail.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
      expect(detail.commentsCursor).toBe("2");
      expect(detail.states.map((state) => state.name)).toEqual(["In Progress", "Done"]);
      expect(detail.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 7,
          title: "Fix",
          url: "https://github.com/acme/web/pull/7",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["state-changed", "In Progress"],
        ["labeled", "bug"],
        ["unlabeled", "old"],
      ]);
      const older = yield* api.getComments({ ...target, key: "ENG-1", cursor: "2" });
      expect(requests.at(-1)?.params.get("orderBy")).toBe("-created");
      expect(older.comments.map((comment) => comment.id)).toEqual(["c3", "c4"]);
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
          issue("ENG-5", { description: doc({ type: "mediaSingle", content: [] }) }),
        "PUT /issue/ENG-1": (seen) => void writes.push(seen),
        "POST /issue/ENG-1/comment": (seen) => void writes.push(seen),
        "POST /issue/ENG-1/transitions": (seen) => void writes.push(seen),
        "GET /user/assignable/search": () => [THEO, user("5b10ac8d82e05b22cc7d4ef6", "Theo")],
        "GET /issue/createmeta/ENG/issuetypes": () => ({
          issueTypes: [
            { id: "5", name: "Sub-task", subtask: true },
            { id: "10001", name: "Task", subtask: false },
          ],
        }),
        "POST /issue": (seen) => {
          writes.push(seen);
          return { id: "100", key: "ENG-42" };
        },
      });
      const api = yield* tracker;
      // A key from another project resolves in Jira, so the project is checked before writing.
      const foreign = yield* Effect.flip(api.comment({ ...target, key: "OPS-3", body: "hi" }));
      expect(foreign.detail).toBe("OPS-3 belongs to Jira project OPS, not ENG.");
      // Its attachment would not survive the Markdown round trip, so the body is not rewritten.
      const attached = yield* Effect.flip(api.update({ ...target, key: "ENG-5", body: "new" }));
      expect(attached.detail).toContain("Edit it in Jira");
      const ambiguous = yield* Effect.flip(
        api.update({ ...target, key: "ENG-1", assignees: ["Theo"] }),
      );
      expect(ambiguous.detail).toContain("More than one");

      yield* api.comment({ ...target, key: "ENG-1", body: "**Done**" });
      yield* api.update({ ...target, key: "ENG-1", title: "Renamed", assignees: [THEO.accountId] });
      yield* api.setState({ ...target, key: "ENG-1", state: "Done" });
      const created = yield* api.create({
        ...target,
        title: "New",
        body: "",
        labels: [],
        assignees: [],
      });
      expect(created.url).toBe("https://acme.atlassian.net/browse/ENG-42");
      expect(writes.map((write) => [write.method, write.path, write.body])).toEqual([
        [
          "POST",
          "/issue/ENG-1/comment",
          {
            body: doc({
              type: "paragraph",
              content: [{ type: "text", text: "Done", marks: [{ type: "strong" }] }],
            }),
          },
        ],
        [
          "PUT",
          "/issue/ENG-1",
          { fields: { summary: "Renamed", assignee: { accountId: THEO.accountId } } },
        ],
        ["POST", "/issue/ENG-1/transitions", { transition: { id: "31" } }],
        [
          "POST",
          "/issue",
          { fields: { project: { key: "ENG" }, issuetype: { id: "10001" }, summary: "New" } },
        ],
      ]);
    }),
  );

  it.effect("maps Jira's refusals to the tracker's failure reasons", () =>
    Effect.gen(function* () {
      const { tracker } = fakeJira({
        "GET /myself": () => new Response("", { status: 401 }),
        "POST /search/jql": () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
        "GET /issue/ENG-1": () =>
          new Response(new ReadableStream(), { headers: { "content-type": "application/json" } }),
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
      expect(limited.retryAt).toBeGreaterThan(0);
      const refused = yield* Effect.flip(
        api.create({ ...target, title: "x", body: "", labels: [], assignees: [] }),
      );
      expect(refused.detail).toBe("You cannot create issues here.");
      // A reply that sends its headers and then stalls still ends at the deadline.
      const stalled = yield* Effect.forkChild(
        Effect.flip(api.getIssue({ ...target, key: "ENG-1" })),
      );
      yield* TestClock.adjust("31 seconds");
      expect((yield* Fiber.join(stalled)).detail).toBe("Jira could not be reached.");
    }),
  );
});
