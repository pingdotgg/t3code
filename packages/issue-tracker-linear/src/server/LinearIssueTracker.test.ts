import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

const user = (id: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  email: `${displayName}@acme.test`,
  avatarUrl: null,
});
const JULIUS = user("usr_julius", "julius");
const THEO = user("usr_theo", "theo");

const state = (name: string, type: string, position = 0) => ({
  id: `st_${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type,
  position,
});

const issue = (
  identifier: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: `iss_${identifier}`,
  identifier,
  number: Number(identifier.split("-")[1]),
  title: `Issue ${identifier}`,
  url: `https://linear.app/acme/issue/${identifier}`,
  description: "body",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  state: state("In Progress", "started"),
  // The detail query also asks for the team's workflow; a listing ignores it.
  team: {
    key: identifier.split("-")[0],
    states: {
      nodes: [
        state("Canceled", "canceled", 3),
        state("Done", "completed", 2),
        state("In Progress", "started", 1),
        state("Todo", "unstarted", 0),
      ],
    },
  },
  creator: JULIUS,
  botActor: null,
  assignee: THEO,
  labels: { nodes: [{ id: "lbl_bug", name: "Bug", color: "#f00" }] },
  ...overrides,
});

/** An issue as the detail query answers it, with nothing hanging off it. */
const bareDetail = (identifier: string, overrides: Partial<Record<string, unknown>> = {}) =>
  issue(identifier, {
    priority: 0,
    estimate: null,
    dueDate: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    parent: null,
    children: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    reactions: [],
    attachments: { nodes: [] },
    history: { nodes: [] },
    ...overrides,
  });

const teamScope = (overrides: Partial<Record<string, unknown>> = {}) => ({
  teams: {
    nodes: [
      {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        states: {
          nodes: [
            state("Canceled", "canceled", 3),
            state("Done", "completed", 2),
            state("Todo", "unstarted", 1),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        members: { nodes: [JULIUS, THEO], pageInfo: { hasNextPage: false, endCursor: null } },
        templates: { nodes: [] },
        ...overrides,
      },
    ],
  },
  issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
});

/** Answers each GraphQL document by its operation name, the way Linear would. */
function fakeLinear(
  answers: Record<string, (variables: Record<string, unknown>) => unknown>,
  stored: string | null = "lin_api_stored",
  beforeAnswer?: (operation: string) => Effect.Effect<void>,
) {
  const requests: Array<{
    readonly authorization: string | undefined;
    readonly operation: string;
    readonly query: string;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body;
        const text =
          body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : String(body._tag);
        const parsed = JSON.parse(text) as { query: string; variables: Record<string, unknown> };
        const operation = /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
        requests.push({
          authorization: request.headers.authorization,
          operation,
          query: parsed.query,
        });
        if (beforeAnswer !== undefined) yield* beforeAnswer(operation);
        const answer = answers[operation];
        const answered = answer?.(parsed.variables);
        const response =
          answered instanceof Response
            ? answered
            : answer === undefined
              ? new Response(
                  JSON.stringify({ errors: [{ message: `No answer for ${operation}` }] }),
                  {
                    status: 400,
                    headers: { "content-type": "application/json" },
                  },
                )
              : new Response(JSON.stringify({ data: answered }), {
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
  // Every optional write is implemented here; the type says so for the calls below.
  const tracker = LinearIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(LinearApi.layer.pipe(Layer.provide(Layer.merge(http, host)))),
  );
  return { tracker, requests };
}

const target = { cwd: "/w/web", host: "linear.app", scope: "ENG" };

describe("LinearIssueTracker", () => {
  it.effect("matches an issue number only in the team it names", () =>
    Effect.gen(function* () {
      const numbers: Array<number | undefined> = [];
      const { tracker } = fakeLinear({
        T3Issues: (variables) => {
          const filter = variables.filter as {
            or: ReadonlyArray<{ number?: { eq: number } }>;
          };
          numbers.push(filter.or.find((clause) => clause.number)?.number?.eq);
          return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        },
      });
      const api = yield* tracker;
      for (const [scope, query] of [
        [" eng ", "eng-42"],
        ["OTHER", "ENG-42"],
        ["OTHER", "42"],
        ["OTHER", "#42"],
      ] as const) {
        yield* api.listIssues({
          ...target,
          scope,
          query,
          state: "all",
          involvement: "all",
          sort: "updated",
          limit: 50,
        });
      }
      expect(numbers).toEqual([42, undefined, 42, 42]);
    }),
  );

  it.effect("cancels the in-flight viewer read when the issue is missing", () =>
    Effect.gen(function* () {
      const viewerStarted = yield* Deferred.make<void>();
      const viewerCanceled = yield* Deferred.make<void>();
      const { tracker } = fakeLinear(
        {
          T3Issue: () =>
            new Response(JSON.stringify({ errors: [{ message: "Issue not found" }] }), {
              headers: { "content-type": "application/json" },
            }),
        },
        "lin_api_stored",
        (operation) =>
          operation === "T3Viewer"
            ? Deferred.succeed(viewerStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(viewerCanceled, undefined)),
              )
            : Deferred.await(viewerStarted),
      );

      const api = yield* tracker;
      const error = yield* Effect.flip(api.getIssue({ ...target, key: "ENG-1" }));
      expect(error.reason).toBe("not-found");
      expect(yield* Deferred.isDone(viewerCanceled)).toBe(true);
    }),
  );

  it.effect("parses Linear issue links with their workspace and team", () =>
    Effect.gen(function* () {
      const api = yield* fakeLinear({}).tracker;
      for (const suffix of ["", "/issue-title", "/old-title?view=all#comment"]) {
        expect(api.parseIssueUrl(new URL(`https://linear.app/acme/issue/ENG-1${suffix}`))).toEqual({
          host: "linear.app",
          workspace: "acme",
          scope: "ENG",
          key: "ENG-1",
        });
      }
      expect(
        api.parseIssueUrl(new URL("https://linear.app/other-workspace/issue/ENG-1")),
      ).toMatchObject({
        workspace: "other-workspace",
        key: "ENG-1",
      });
      for (const url of [
        "http://linear.app/acme/issue/ENG-1",
        "https://example.com/acme/issue/ENG-1",
        "https://linear.app.example.com/acme/issue/ENG-1",
        "https://linear.app:444/acme/issue/ENG-1",
        "https://linear.app/acme/team/ENG-1",
        "https://linear.app//issue/ENG-1",
        "https://linear.app/acme/issue/",
        "https://linear.app/acme/issue/ENG-0",
        "https://linear.app/acme/issue/eng-1",
        "https://linear.app/acme/issue/ENG-1extra",
      ]) {
        expect(api.parseIssueUrl(new URL(url)), url).toBeNull();
      }
    }),
  );

  it.effect("lists a team's issues as summaries keyed by identifier", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Viewer: () => ({
          viewer: JULIUS,
          organization: { urlKey: "acme" },
          teams: { nodes: [] },
        }),
        T3Issues: (variables) => {
          expect(variables.filter).toMatchObject({
            team: { key: { eq: "ENG" } },
            state: { type: { nin: ["completed", "canceled", "duplicate"] } },
            // "Assigned to me" survives an assignee filter: both must hold.
            assignee: { displayName: { eq: "julius" } },
            and: [
              { assignee: { displayName: { eq: "theo" } } },
              { labels: { some: { name: { eq: "Bug" } } } },
            ],
          });
          expect(variables.orderBy).toBe("createdAt");
          return {
            issues: {
              nodes: [
                issue("ENG-2", {
                  state: state("Done", "completed"),
                  completedAt: "2026-07-03T00:00:00.000Z",
                }),
                issue("ENG-1"),
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur_2" },
            },
          };
        },
      });
      const api = yield* tracker;
      expect(api.kind).toBe(IssueTrackerKind.make("linear"));
      expect(api.standalone).toMatchObject({ host: "linear.app", scopeNoun: "team" });

      const page = yield* api.listIssues({
        ...target,
        state: "open",
        involvement: "assigned",
        viewer: "julius",
        labels: ["Bug"],
        assignee: "theo",
        sort: "created",
        limit: 50,
      });
      expect(page.nextCursor).toBe("cur_2");
      expect(page.items.map((item) => [item.key, item.displayKey, item.state])).toEqual([
        ["ENG-2", "ENG-2", { category: "closed", name: "Done", closeReason: "completed" }],
        ["ENG-1", "ENG-1", { category: "open", name: "In Progress" }],
      ]);
      // A listing carries no comment totals, whatever the row's position.
      expect(page.items.map((item) => item.commentCount)).toEqual([0, 0]);
      expect(page.items[0]).toMatchObject({
        closedAt: "2026-07-03T00:00:00.000Z",
        author: { login: "julius", name: "julius" },
        assignees: [{ login: "theo", name: "theo" }],
        labels: [{ name: "Bug", color: "#f00" }],
      });
      // The stored key goes in as-is, not as a bearer token.
      expect(requests.map((request) => request.authorization)).toEqual(["lin_api_stored"]);
      // Rows never show a body, so the listing leaves descriptions to the detail query.
      expect(requests[0]?.query).not.toMatch(/\bdescription\b/);

      // Linear's reset header is an absolute time in epoch milliseconds.
      const resetAt = 4_102_444_800_000;
      const limited = fakeLinear({
        T3Issues: () =>
          new Response(JSON.stringify({ errors: [{ message: "Rate limited" }] }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-requests-reset": String(resetAt),
            },
          }),
      });
      const refused = yield* Effect.flip(
        (yield* limited.tracker).listIssues({
          ...target,
          state: "open",
          involvement: "all",
          sort: "updated",
          limit: 50,
        }),
      );
      expect([refused.reason, refused.retryAt]).toEqual(["rate-limited", resetAt]);
    }),
  );

  it.effect("reacts to a comment only when it belongs to the issue named", () =>
    Effect.gen(function* () {
      const created: Array<unknown> = [];
      const deleted: Array<unknown> = [];
      const { tracker } = fakeLinear({
        T3Viewer: () => ({
          viewer: JULIUS,
          organization: { urlKey: "acme" },
          teams: { nodes: [] },
        }),
        T3Issue: (variables) => {
          // Linear refuses a page of zero comments, which fails the write that looked the issue up.
          expect(variables.comments).toBeGreaterThan(0);
          return { issue: bareDetail(String(variables.id)) };
        },
        T3CommentReactions: (variables) => ({
          comment: {
            issue: { id: variables.id === "cmt_own" ? "iss_ENG-1" : "iss_OPS-9" },
            reactions: [{ id: "r1", emoji: "+1", user: JULIUS }],
          },
        }),
        T3ReactionCreate: (variables) => {
          created.push(variables.input);
          return { reactionCreate: { success: true } };
        },
        T3ReactionDelete: (variables) => {
          deleted.push(variables.id);
          return { reactionDelete: { success: true } };
        },
      });
      const api = yield* tracker;
      const reaction = { ...target, key: "ENG-1", content: "thumbs-up" as const };
      for (const reacted of [true, false]) {
        const foreign = yield* Effect.flip(
          api.setReaction({ ...reaction, subjectId: "cmt_other", reacted }),
        );
        expect(foreign.detail).toBe("The comment does not belong to the selected issue.");
      }
      expect([created, deleted]).toEqual([[], []]);

      yield* api.setReaction({ ...reaction, subjectId: "cmt_own", reacted: true });
      yield* api.setReaction({ ...reaction, subjectId: "cmt_own", reacted: false });
      expect(created).toEqual([{ commentId: "cmt_own", emoji: "👍" }]);
      expect(deleted).toEqual(["r1"]);
    }),
  );

  it.effect("reads the viewer only for comment pages with reactions", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Comments: ({ after }) => ({
          issue: {
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "hi",
                  createdAt: "2026-07-02T01:00:00.000Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment-cmt_1",
                  user: THEO,
                  botActor: null,
                  reactions: after === "reacted" ? [{ id: "r1", emoji: "+1", user: JULIUS }] : [],
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        T3Viewer: () => ({
          viewer: JULIUS,
          organization: { urlKey: "acme" },
          teams: { nodes: [] },
        }),
      });
      const api = yield* tracker;
      const viewerReads = () => requests.filter((r) => r.operation === "T3Viewer").length;
      const ref = { ...target, key: "ENG-7" };
      const plain = yield* api.getComments({ ...ref, cursor: "plain" });
      expect(plain.comments[0]?.reactions).toEqual([]);
      expect(viewerReads()).toBe(0);
      const reacted = yield* api.getComments({ ...ref, cursor: "reacted" });
      expect(reacted.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      ]);
      expect(viewerReads()).toBe(1);
    }),
  );

  it.effect("reads an issue with its comments, reactions, history and linked pull requests", () =>
    Effect.gen(function* () {
      const { tracker } = fakeLinear({
        T3Viewer: () => ({
          viewer: JULIUS,
          organization: { urlKey: "acme" },
          teams: { nodes: [] },
        }),
        T3Issue: () => ({
          issue: bareDetail("ENG-7", {
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "hi",
                  createdAt: "2026-07-02T01:00:00.000Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment-cmt_1",
                  user: THEO,
                  botActor: null,
                  reactions: [{ id: "r1", emoji: "+1", user: JULIUS }],
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cmt_cur" },
            },
            reactions: [
              { id: "r2", emoji: "🚀", user: THEO },
              { id: "r3", emoji: "rocket", user: JULIUS },
              { id: "r4", emoji: "🤷", user: THEO },
            ],
            attachments: {
              nodes: [
                {
                  url: "https://github.com/acme/web/pull/12",
                  title: "Fix it",
                  sourceType: "github",
                  metadata: { status: "merged" },
                },
                { url: "https://example.test/doc", title: "Doc", sourceType: null, metadata: {} },
              ],
            },
            history: {
              nodes: [
                {
                  id: "h1",
                  createdAt: "2026-07-01T01:00:00.000Z",
                  // An integration acted: Linear names it beside an empty user.
                  actor: null,
                  botActor: { name: "GitHub", userDisplayName: null, avatarUrl: null },
                  fromState: state("Todo", "unstarted"),
                  toState: state("Done", "completed"),
                  fromAssignee: null,
                  toAssignee: JULIUS,
                  addedLabels: [{ id: "lbl_bug", name: "Bug", color: "#f00" }],
                  removedLabels: null,
                  fromTitle: null,
                  toTitle: null,
                },
              ],
            },
          }),
        }),
      });
      const api = yield* tracker;
      const detail = yield* api.getIssue({ ...target, key: "eng-7" });
      expect(detail.viewer).toBe("julius");
      expect(detail.body).toBe("body");
      expect((yield* api.probeCredential("token")).workspace).toBe("acme");
      // The team's own workflow, in Linear's order, with the category each state falls in.
      expect(detail.states.map((entry) => [entry.name, entry.category])).toEqual([
        ["Todo", "open"],
        ["In Progress", "open"],
        ["Done", "closed"],
        ["Canceled", "closed"],
      ]);
      expect(detail.commentsCursor).toBe("cmt_cur");
      expect(detail.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      ]);
      // Grouped per emoji, the viewer left out of the names; an emoji outside the vocabulary is dropped.
      expect(detail.reactions).toEqual([
        { content: "rocket", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      expect(detail.events.map((event) => [event.kind, event.detail])).toEqual([
        ["closed", "Done"],
        ["labeled", "Bug"],
        ["assigned", "julius"],
      ]);
      expect(detail.events[0]?.actor).toEqual({
        isBot: true,
        login: "GitHub",
        name: "GitHub",
        avatarUrl: null,
      });
      expect(detail.linkedPullRequests).toEqual([
        expect.objectContaining({ repository: "acme/web", number: 12, state: "merged" }),
      ]);

      const missing = yield* Effect.flip(api.getIssue({ ...target, key: "123" }));
      expect(missing.reason).toBe("not-found");
    }),
  );

  it.effect("closes through the team's completed state, without a key or outside the team", () =>
    Effect.gen(function* () {
      const updates: Array<Record<string, unknown>> = [];
      const { tracker } = fakeLinear(
        {
          T3Team: () => teamScope(),
          T3IssueUpdate: (variables) => {
            updates.push(variables);
            return { issueUpdate: { success: true } };
          },
        },
        null,
      );
      const api = yield* tracker;
      const unauthenticated = yield* Effect.flip(
        api.setState({ ...target, key: "ENG-1", state: "Done" }),
      );
      expect(unauthenticated.reason).toBe("unauthenticated");

      const connected = fakeLinear({
        T3Team: () => teamScope(),
        T3Issue: (variables) => ({ issue: bareDetail(String(variables.id)) }),
        T3IssueUpdate: (variables) => {
          updates.push(variables);
          return { issueUpdate: { success: true } };
        },
      });
      const live = yield* connected.tracker;
      // An identifier from another team resolves in Linear, so the team is checked before writing.
      const foreign = yield* Effect.flip(live.setState({ ...target, key: "OPS-3", state: "Done" }));
      expect(foreign.detail).toContain("OPS");
      // A move names one of the team's own states; nothing is asked for as "open" or "closed".
      yield* live.setState({ ...target, key: "ENG-1", state: "Canceled" });
      yield* live.setState({ ...target, key: "ENG-1", state: "Todo" });
      const unknown = yield* Effect.flip(
        live.setState({ ...target, key: "ENG-1", state: "closed" }),
      );
      expect(unknown.detail).toContain('no "closed" state');
      expect(updates.map((update) => update.input)).toEqual([
        { stateId: "st_canceled" },
        { stateId: "st_todo" },
      ]);
    }),
  );

  it("offers plain templates as drafts and form or rich ones as links into Linear", () => {
    const labels = new Map([["lbl_bug", "Bug"]]);
    const plain = LinearIssueTracker.toTemplate(
      {
        id: "tpl_1",
        name: "Bug report",
        description: "For bugs",
        content: "## Steps",
        type: "issue",
        hasFormFields: false,
        templateData: { title: "Bug: ", labelIds: ["lbl_bug", "lbl_unknown"], assigneeId: null },
      },
      "ENG",
      labels,
    );
    expect(plain).toEqual({
      template: {
        key: "tpl_1",
        name: "Bug report",
        about: "For bugs",
        title: "Bug: ",
        body: "## Steps",
        labels: ["Bug"],
        assignees: [],
      },
    });
    const form = LinearIssueTracker.toTemplate(
      {
        id: "tpl_2",
        name: "Intake",
        description: null,
        content: null,
        type: "issue",
        hasFormFields: true,
        templateData: {},
      },
      "ENG",
      labels,
    );
    expect(form).toEqual({
      link: { name: "Intake", about: "", url: "https://linear.app/team/ENG/new?template=tpl_2" },
    });
  });

  it.effect(
    "reads and writes native priority, sub-issues, blocking edges, projects, milestones, cycles, and project dependencies",
    () =>
      Effect.gen(function* () {
        const createdIssues: Array<Record<string, unknown>> = [];
        const updatedIssues: Array<Record<string, unknown>> = [];
        const createdRelations: Array<Record<string, unknown>> = [];
        const deletedRelations: Array<string> = [];
        const createdProjects: Array<Record<string, unknown>> = [];
        const createdMilestones: Array<Record<string, unknown>> = [];
        const createdProjectRelations: Array<Record<string, unknown>> = [];
        const deletedProjectRelations: Array<string> = [];

        const projectAlpha = {
          id: "proj_alpha",
          name: "Catalog Unification",
          slugId: "catalog-unification",
          url: "https://linear.app/acme/project/catalog-unification",
          description: "Unify catalog intake",
          status: { name: "In Progress" },
          projectMilestones: {
            nodes: [
              { id: "ms_1", name: "Phase 1", description: "Core schema", targetDate: "2026-12-01" },
            ],
          },
          relations: {
            nodes: [
              {
                id: "prel_1",
                type: "dependency",
                anchorType: "end",
                relatedAnchorType: "start",
                project: { id: "proj_alpha", name: "Catalog Unification" },
                projectMilestone: null,
                relatedProject: { id: "proj_beta", name: "Search Rollout" },
                relatedProjectMilestone: null,
              },
            ],
          },
          inverseRelations: { nodes: [] },
        };
        const projectBeta = {
          id: "proj_beta",
          name: "Search Rollout",
          slugId: "search-rollout",
          url: "https://linear.app/acme/project/search-rollout",
          description: "",
          status: { name: "Planned" },
          projectMilestones: {
            nodes: [{ id: "ms_beta_1", name: "GA", description: null, targetDate: "2027-01-15" }],
          },
          relations: { nodes: [] },
          inverseRelations: { nodes: projectAlpha.relations.nodes },
        };
        const cycle5 = {
          id: "cyc_5",
          number: 5,
          name: "Sprint 5",
          startsAt: "2026-11-16T00:00:00.000Z",
          endsAt: "2026-11-30T00:00:00.000Z",
        };
        const issueRef = (identifier: string, title: string) => ({
          id: `iss_${identifier}`,
          identifier,
          title,
          url: `https://linear.app/acme/issue/${identifier}`,
          team: { key: identifier.split("-")[0] },
          state: state("Todo", "unstarted"),
        });

        const { tracker } = fakeLinear({
          T3Viewer: () => ({
            viewer: JULIUS,
            organization: { urlKey: "acme" },
            teams: { nodes: [] },
          }),
          T3Team: () => teamScope(),
          T3TeamProjects: () => ({
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  projects: {
                    nodes: [projectAlpha, projectBeta],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  cycles: {
                    nodes: [cycle5],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
            },
          }),
          T3Issue: (variables) => ({
            issue: bareDetail(String(variables.id), {
              priority: 2,
              estimate: 3,
              dueDate: "2026-12-15",
              project: {
                id: projectAlpha.id,
                name: projectAlpha.name,
                slugId: projectAlpha.slugId,
                url: projectAlpha.url,
                description: projectAlpha.description,
                status: projectAlpha.status,
              },
              projectMilestone: projectAlpha.projectMilestones.nodes[0],
              cycle: cycle5,
              parent: issueRef("ENG-1", "Parent Spec"),
              children: { nodes: [issueRef("ENG-3", "Subtask A")] },
              relations: {
                nodes: [
                  { id: "rel_blocks", type: "blocks", relatedIssue: issueRef("ENG-4", "Blocked") },
                ],
              },
              inverseRelations: {
                nodes: [{ id: "rel_blocked", type: "blocks", issue: issueRef("ENG-2", "Blocker") }],
              },
            }),
          }),
          T3IssueCreate: (variables) => {
            createdIssues.push(variables.input as Record<string, unknown>);
            return {
              issueCreate: {
                success: true,
                issue: {
                  identifier: "ENG-10",
                  url: "https://linear.app/acme/issue/ENG-10",
                },
              },
            };
          },
          T3IssueUpdate: (variables) => {
            updatedIssues.push(variables);
            return { issueUpdate: { success: true } };
          },
          T3IssueRelationCreate: (variables) => {
            createdRelations.push(variables.input as Record<string, unknown>);
            return { issueRelationCreate: { success: true, issueRelation: { id: "rel_new" } } };
          },
          T3IssueRelationDelete: (variables) => {
            deletedRelations.push(String(variables.id));
            return { issueRelationDelete: { success: true } };
          },
          T3ProjectCreate: (variables) => {
            createdProjects.push(variables.input as Record<string, unknown>);
            return {
              projectCreate: {
                success: true,
                project: {
                  id: "proj_gamma",
                  name: "Gamma",
                  slugId: "gamma",
                  url: "https://linear.app/acme/project/gamma",
                  description: "New project",
                  status: { name: "Planned" },
                },
              },
            };
          },
          T3ProjectMilestoneCreate: (variables) => {
            createdMilestones.push(variables.input as Record<string, unknown>);
            return {
              projectMilestoneCreate: {
                success: true,
                projectMilestone: {
                  id: "ms_gamma_1",
                  name: "Beta",
                  description: null,
                  targetDate: "2027-02-01",
                },
              },
            };
          },
          T3ProjectRelationCreate: (variables) => {
            createdProjectRelations.push(variables.input as Record<string, unknown>);
            return {
              projectRelationCreate: { success: true, projectRelation: { id: "prel_new" } },
            };
          },
          T3ProjectRelationDelete: (variables) => {
            deletedProjectRelations.push(String(variables.id));
            return { projectRelationDelete: { success: true } };
          },
        });

        const api = yield* tracker;
        const detail = yield* api.getIssue({ ...target, key: "ENG-5" });
        expect(detail.priority).toBe("high");
        expect(detail.estimate).toBe(3);
        expect(detail.dueDate).toBe("2026-12-15");
        expect(detail.project).toMatchObject({ id: "proj_alpha", name: "Catalog Unification" });
        expect(detail.milestone).toMatchObject({ id: "ms_1", name: "Phase 1" });
        expect(detail.cycle).toMatchObject({ id: "cyc_5", number: 5, name: "Sprint 5" });
        expect(detail.parent).toMatchObject({ key: "ENG-1", title: "Parent Spec" });
        expect(detail.subIssues).toEqual([expect.objectContaining({ key: "ENG-3" })]);
        expect(detail.relations).toEqual([
          expect.objectContaining({
            id: "rel_blocks",
            kind: "blocks",
            issue: expect.objectContaining({ key: "ENG-4" }),
          }),
          expect.objectContaining({
            id: "rel_blocked",
            kind: "blocked-by",
            issue: expect.objectContaining({ key: "ENG-2" }),
          }),
        ]);

        const candidates = yield* api.listCandidates(target);
        expect(candidates.projects).toEqual([
          expect.objectContaining({
            id: "proj_alpha",
            milestones: [expect.objectContaining({ id: "ms_1", name: "Phase 1" })],
            relations: [
              expect.objectContaining({
                id: "prel_1",
                kind: "blocks",
                projectId: "proj_beta",
                anchor: "end",
                relatedAnchor: "start",
              }),
            ],
          }),
          expect.objectContaining({
            id: "proj_beta",
            relations: [
              expect.objectContaining({
                id: "prel_1",
                kind: "blocked-by",
                projectId: "proj_alpha",
                anchor: "start",
                relatedAnchor: "end",
              }),
            ],
          }),
        ]);
        expect(candidates.cycles).toEqual([expect.objectContaining({ id: "cyc_5", number: 5 })]);

        // Create a sub-issue with project, milestone, cycle, priority, state, and blocking edges.
        const created = yield* api.create({
          ...target,
          title: "Subtask with deps",
          body: "Details",
          labels: [],
          assignees: ["theo"],
          state: "Todo",
          priority: "urgent",
          estimate: 5,
          dueDate: "2026-12-20",
          parent: "eng-1",
          project: "Catalog Unification",
          milestone: "Phase 1",
          cycle: "5",
          blocks: ["eng-4"],
          blockedBy: ["eng-2"],
        });
        expect(created.key).toBe("ENG-10");
        expect(createdIssues[0]).toEqual({
          teamId: "team_eng",
          title: "Subtask with deps",
          description: "Details",
          labelIds: [],
          assigneeId: "usr_theo",
          stateId: "st_todo",
          priority: 1,
          estimate: 5,
          dueDate: "2026-12-20",
          parentId: "ENG-1",
          projectId: "proj_alpha",
          projectMilestoneId: "ms_1",
          cycleId: "cyc_5",
        });
        expect(createdRelations).toEqual([
          { issueId: "ENG-10", relatedIssueId: "ENG-4", type: "blocks" },
          { issueId: "ENG-2", relatedIssueId: "ENG-10", type: "blocks" },
        ]);

        // Update issue: detach parent, clear project & dueDate, change priority.
        yield* api.update({
          ...target,
          key: "ENG-5",
          priority: "low",
          parent: null,
          project: null,
          dueDate: null,
          estimate: null,
          cycle: null,
        });
        expect(updatedIssues[0]).toEqual({
          id: "ENG-5",
          input: {
            priority: 4,
            parentId: null,
            projectId: null,
            dueDate: null,
            estimate: null,
            cycleId: null,
          },
        });

        // Add new blocking edge, skip already-existing edge, and remove existing inverse edge.
        yield* api.setRelation({
          ...target,
          key: "ENG-5",
          action: "add",
          kind: "blocks",
          targetKey: "ENG-9",
        });
        yield* api.setRelation({
          ...target,
          key: "ENG-5",
          action: "add",
          kind: "blocks",
          targetKey: "ENG-4",
        });
        yield* api.setRelation({
          ...target,
          key: "ENG-5",
          action: "remove",
          kind: "blocked-by",
          targetKey: "ENG-2",
        });
        expect(createdRelations.at(-1)).toEqual({
          issueId: "ENG-5",
          relatedIssueId: "ENG-9",
          type: "blocks",
        });
        expect(deletedRelations).toEqual(["rel_blocked"]);

        // Create a project with milestones.
        const newProject = yield* api.createProject({
          ...target,
          name: "Gamma",
          description: "New project",
          priority: "high",
          lead: "julius",
          startDate: "2026-12-01",
          targetDate: "2027-02-01",
          milestones: [{ name: "Beta", targetDate: "2027-02-01" }],
        });
        expect(newProject).toMatchObject({
          id: "proj_gamma",
          name: "Gamma",
          milestones: [{ id: "ms_gamma_1", name: "Beta", targetDate: "2027-02-01" }],
        });
        expect(createdProjects[0]).toEqual({
          teamIds: ["team_eng"],
          name: "Gamma",
          description: "New project",
          priority: 2,
          leadId: "usr_julius",
          startDate: "2026-12-01",
          targetDate: "2027-02-01",
        });
        expect(createdMilestones[0]).toEqual({
          projectId: "proj_gamma",
          name: "Beta",
          targetDate: "2027-02-01",
        });

        // Wire a milestone-anchored project dependency and remove an existing project dependency.
        yield* api.setProjectRelation({
          ...target,
          action: "add",
          project: "Catalog Unification",
          kind: "blocks",
          targetProject: "Search Rollout",
          milestone: "Phase 1",
          targetMilestone: "GA",
        });
        expect(createdProjectRelations[0]).toEqual({
          projectId: "proj_alpha",
          relatedProjectId: "proj_beta",
          type: "dependency",
          anchorType: "milestone",
          relatedAnchorType: "milestone",
          projectMilestoneId: "ms_1",
          relatedProjectMilestoneId: "ms_beta_1",
        });
        yield* api.setProjectRelation({
          ...target,
          action: "remove",
          project: "Search Rollout",
          kind: "blocked-by",
          targetProject: "Catalog Unification",
        });
        expect(deletedProjectRelations).toEqual(["prel_1"]);
      }),
  );
});
