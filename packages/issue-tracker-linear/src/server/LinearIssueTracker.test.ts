import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { stripIgnoredCharacters } from "graphql";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueSummary, IssueTrackerKind, IssueTrackerScopePage } from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as LinearApi from "./LinearApi.ts";
import * as LinearIssueTracker from "./LinearIssueTracker.ts";

const user = (id: string, displayName: string) => ({
  id,
  name: displayName,
  displayName,
  email: `${displayName}@acme.test`,
  avatarUrl: null,
  active: true,
});
const JULIUS = user("usr_julius", "julius");
const THEO = user("usr_theo", "theo");
const ORGANIZATION = {
  id: "org_acme",
  urlKey: "acme",
  templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};

const state = (name: string, type: string, position = 0) => ({
  id: `st_${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type,
  position,
});

const labelFixture = <
  T extends {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly description?: string | null;
    readonly archivedAt?: string | null;
    readonly isGroup?: boolean;
  },
>(
  input: T,
) => ({
  ...input,
  description: input.description ?? null,
  archivedAt: input.archivedAt ?? null,
  isGroup: input.isGroup ?? false,
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
  reactions: [],
  state: state("In Progress", "started"),
  creator: JULIUS,
  assignee: THEO,
  team: {
    key: identifier.split("-")[0],
    states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  },
  labels: {
    nodes: [labelFixture({ id: "lbl_bug", name: "Bug", color: "#f00" })],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  ...overrides,
  projectMilestone: overrides.projectMilestone ?? null,
});

/** Answers each GraphQL document by its operation name, the way Linear would. */
function fakeLinear(
  answers: Record<string, (variables: Record<string, unknown>) => unknown>,
  stored: string | null = "lin_api_stored",
) {
  let currentToken = stored;
  const requests: Array<{
    readonly authorization: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body = request.body;
        const text =
          body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : String(body._tag);
        const parsed = JSON.parse(text) as {
          query: string;
          operationName?: string;
          variables: Record<string, unknown>;
        };
        const operation =
          parsed.operationName ?? /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
        requests.push({
          authorization: request.headers.authorization,
          operation,
          query: parsed.query,
          variables: parsed.variables,
        });
        const answer = answers[operation];
        const response =
          answer === undefined
            ? new Response(
                JSON.stringify({ errors: [{ message: `No answer for ${operation}` }] }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              )
            : (() => {
                const result = answer(parsed.variables);
                return result instanceof Response
                  ? result
                  : new Response(JSON.stringify({ data: result }), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    });
              })();
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.sync(() => Option.fromNullishOr(currentToken)) },
    }),
  );
  // Every optional write is implemented here; the type says so for the calls below.
  const dependencies = Layer.mergeAll(
    http,
    host,
    RateLimit.layer,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
        digest: (algorithm, data) =>
          Effect.promise(() =>
            globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data).buffer),
          ).pipe(Effect.map((buffer) => new Uint8Array(buffer))),
      }),
    ),
  );
  const tracker = LinearIssueTracker.make.pipe(
    Effect.map((api) => api as Required<StandaloneIssueTrackerApi>),
    Effect.provide(LinearApi.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    tracker,
    requests,
    api: LinearApi.make.pipe(Effect.provide(dependencies)),
    setToken: (value: string) => {
      currentToken = value;
    },
  };
}

const compactQuery = (query: string | undefined) => stripIgnoredCharacters(query ?? "");

const target = { cwd: "/w/web", host: "linear.app", scope: "ENG" };
const decodeIssueSummary = Schema.decodeEffect(IssueSummary);
const decodeScopePage = Schema.decodeEffect(IssueTrackerScopePage);

it.effect("continues the selected account team catalog with one native request per page", () =>
  Effect.gen(function* () {
    const teams = (start: number, length: number) =>
      Array.from({ length }, (_, index) => ({
        id: `team-${start + index}`,
        key: `T${start + index}`,
        name: `Team ${start + index}`,
      }));
    const test = fakeLinear(
      {
        T3ProbeCredential: () => ({
          viewer: JULIUS,
          organization: ORGANIZATION,
          teams: {
            nodes: teams(0, 250),
            pageInfo: { hasNextPage: true, endCursor: "team-249" },
          },
        }),
        T3Scopes: (variables) => ({
          organization: ORGANIZATION,
          teams: {
            nodes: variables.after === "team-249" ? teams(250, 100) : teams(350, 1),
            pageInfo:
              variables.after === "team-249"
                ? { hasNextPage: true, endCursor: "team-349" }
                : { hasNextPage: false, endCursor: "team-350" },
          },
        }),
      },
      null,
    );
    const api = yield* test.tracker;
    const initial = yield* api.probeCredential("lin_selected");
    expect(initial.scopesCursor).toBe("team-249");
    expect(initial.scopes).toHaveLength(250);
    test.setToken("lin_other_account");
    const page = yield* api.listScopes("lin_selected", { cursor: initial.scopesCursor! });
    expect(page.items).toHaveLength(100);
    expect(page.items[0]).toEqual({ key: "acme/T250", name: "Team 250" });
    expect(page.nextCursor).toBe("team-349");
    const last = yield* api.listScopes("lin_selected", { cursor: page.nextCursor!, limit: 1 });
    expect(yield* decodeScopePage(last)).toEqual({
      items: [{ key: "acme/T350", name: "Team 350" }],
      nextCursor: null,
    });
    expect(test.requests.map(({ operation }) => operation)).toEqual([
      "T3ProbeCredential",
      "T3Scopes",
      "T3Scopes",
    ]);
    expect(test.requests.map(({ authorization }) => authorization)).toEqual(
      Array(3).fill("lin_selected"),
    );
    expect(test.requests[1]?.variables).toEqual({ first: 100, after: "team-249" });
    expect(test.requests[2]?.variables).toEqual({ first: 1, after: "team-349" });
    for (const request of test.requests.slice(1)) expect(request.query).not.toContain("viewer");
  }),
);

it.effect.each([
  { cursor: "" },
  { cursor: " " },
  { cursor: "x".repeat(4097) },
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
])("rejects invalid Linear scope page input without a native request: %j", (input) =>
  Effect.gen(function* () {
    const test = fakeLinear({});
    const api = yield* test.tracker;
    expect((yield* api.listScopes("lin_selected", input).pipe(Effect.flip)).reason).toBe("failed");
    expect(test.requests).toHaveLength(0);
  }),
);

it.effect.each([
  { hasNextPage: true, endCursor: null, count: 1 },
  { hasNextPage: true, endCursor: "same", count: 1 },
  { hasNextPage: true, endCursor: "next", count: 0 },
  { hasNextPage: true, endCursor: " ", count: 1 },
  { hasNextPage: false, endCursor: null, count: 2 },
])("refuses inconsistent Linear scope pages: %j", ({ count, ...pageInfo }) =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3Scopes: () => ({
        organization: ORGANIZATION,
        teams: {
          nodes: Array.from({ length: count }, () => ({
            id: "team",
            key: "ENG",
            name: "Engineering",
          })),
          pageInfo,
        },
      }),
    });
    const api = yield* test.tracker;
    expect(
      (yield* api.listScopes("lin_selected", { cursor: "same", limit: 1 }).pipe(Effect.flip))
        .reason,
    ).toBe("failed");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Scopes"]);
  }),
);

it.effect(
  "rejects a partial Linear probe with no continuation and accepts empty terminal scopes",
  () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3ProbeCredential: () => ({
          viewer: JULIUS,
          organization: ORGANIZATION,
          teams: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        }),
        T3Scopes: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      });
      const api = yield* test.tracker;
      expect((yield* api.probeCredential("lin_selected").pipe(Effect.flip)).reason).toBe("failed");
      expect(yield* api.listScopes("lin_selected", {})).toEqual({ items: [], nextCursor: null });
      expect(test.requests).toHaveLength(2);
    }),
);

it.effect.each([401, 429])(
  "preserves native Linear scope-page errors %s without preflight",
  (status) =>
    Effect.gen(function* () {
      const test = fakeLinear({ T3Scopes: () => new Response("{}", { status }) });
      const api = yield* test.tracker;
      expect(
        (yield* api.listScopes("lin_selected", { cursor: "next" }).pipe(Effect.flip)).reason,
      ).toBe(status === 401 ? "unauthenticated" : "rate-limited");
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Scopes"]);
    }),
);

it.effect.each([
  { template: true, assignee: null },
  { template: true, assignee: THEO.id },
  { template: true, assignee: JULIUS.id },
  { template: false, assignee: null },
])(
  "preserves explicit assignee selection over native template defaults: %j",
  ({ template, assignee }) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const preset = {
        id: "preset-assignee",
        name: "Assigned template",
        description: null,
        content: "Steps",
        type: "issue",
        hasFormFields: false,
        templateData: { assigneeId: THEO.id },
      };
      let appliedAssignee: unknown = "no-write";
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                ancestors: [],
                states: empty,
                labels: empty,
                members: { ...empty, nodes: [THEO, JULIUS] },
                templates: { ...empty, nodes: [preset] },
              },
            ],
          },
        }),
        T3IssueCreate: (variables) => {
          const input = variables.input as Record<string, unknown>;
          appliedAssignee = Object.hasOwn(input, "assigneeId")
            ? input.assigneeId
            : input.templateId === preset.id
              ? preset.templateData.assigneeId
              : null;
          return {
            issueCreate: {
              success: true,
              issue: {
                identifier: "ENG-8",
                url: "https://linear.app/acme/issue/ENG-8",
              },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const created = yield* api.create({
        ...target,
        scope: "acme/ENG",
        title: "New",
        body: "Steps",
        labels: [],
        assignees: assignee === null ? [] : [assignee],
        ...(template ? { templateKey: preset.id } : {}),
      });
      expect(appliedAssignee).toBe(assignee);
      expect(created.key).toBe("ENG-8");
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team", "T3IssueCreate"]);
      expect(test.requests[1]?.variables.input).toMatchObject({ assigneeId: assignee });
      if (template)
        expect(test.requests[1]?.variables.input).toMatchObject({ templateId: preset.id });
      else expect(test.requests[1]?.variables.input).not.toHaveProperty("templateId");
    }),
);

it.effect("retains normalized list reactions and native viewer flags in one request", () =>
  Effect.gen(function* () {
    const vocabulary = [
      ["👍", "thumbs-up"],
      ["👎", "thumbs-down"],
      ["😄", "laugh"],
      ["🎉", "hooray"],
      ["😕", "confused"],
      ["❤️", "heart"],
      ["🚀", "rocket"],
      ["👀", "eyes"],
    ];
    const reactions = vocabulary.flatMap(([emoji], index) => [
      { id: `mine-${index}`, emoji, user: JULIUS },
      { id: `other-${index}`, emoji, user: THEO },
    ]);
    const test = fakeLinear({
      T3Issues: () => ({
        organization: ORGANIZATION,
        viewer: { id: JULIUS.id },
        issues: {
          nodes: [
            issue("ENG-7", {
              reactions: [...reactions, { id: "custom", emoji: "custom", user: null }],
            }),
          ],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      }),
    });
    const api = yield* test.tracker;
    const page = yield* api.listIssues({
      ...target,
      state: "all",
      involvement: "all",
      viewer: THEO.id,
      limit: 20,
      cursor: "previous",
    });
    const expected = vocabulary.map(([, content]) => ({
      content,
      count: 2,
      actors: ["theo"],
      viewerHasReacted: true,
    }));
    const summary = page.items[0]!;
    expect(summary).toMatchObject({ reactions: expected, reactionsTruncated: false });
    const wire = yield* decodeIssueSummary({
      ...summary,
      tracker: IssueTrackerKind.make("linear"),
      host: target.host,
      scope: target.scope,
    });
    expect(wire).toMatchObject({ reactions: expected, reactionsTruncated: false });
    expect(page.nextCursor).toBe("next");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
    expect(test.requests[0]?.variables.after).toBe("previous");
    expect(compactQuery(test.requests[0]?.query)).toContain(compactQuery("viewer { id }"));
    expect(compactQuery(test.requests[0]?.query)).toContain(
      compactQuery("reactions { id emoji user {"),
    );
  }),
);

it.effect.each([JULIUS.id, undefined])(
  "bounds list reaction actor previews without losing counts, native viewer %s",
  (viewerId) =>
    Effect.gen(function* () {
      const reactions = [
        { id: "mine", emoji: "👍", user: JULIUS },
        ...Array.from({ length: 21 }, (_, index) => ({
          id: `other-${index}`,
          emoji: "👍",
          user: user(`other-${index}`, `other-${index}`),
        })),
        { id: "anonymous", emoji: "👍", user: null },
      ];
      const test = fakeLinear({
        T3Issues: () => ({
          organization: ORGANIZATION,
          ...(viewerId === undefined ? {} : { viewer: { id: viewerId } }),
          issues: {
            nodes: [issue("ENG-7", { reactions })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 20,
      });
      expect(page.items[0]).toMatchObject({
        reactions: [{ content: "thumbs-up", count: 23, viewerHasReacted: viewerId !== undefined }],
        reactionsTruncated: true,
      });
      expect(page.items[0]?.reactions?.[0]?.actors).toHaveLength(20);
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
    }),
);

it.effect.each([[], undefined])(
  "keeps empty and absent native list reactions distinct: %j",
  (reactions) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Issues: () => ({
          organization: ORGANIZATION,
          viewer: { id: JULIUS.id },
          issues: {
            nodes: [issue("ENG-7", { reactions })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 20,
      });
      if (reactions === undefined) {
        expect(page.items[0]).not.toHaveProperty("reactions");
        expect(page.items[0]).not.toHaveProperty("reactionsTruncated");
      } else expect(page.items[0]).toMatchObject({ reactions: [], reactionsTruncated: false });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
    }),
);

it.effect.each([{ name: "Release 7" }, null, undefined])(
  "retains native project milestones in list, detail, and wire summaries: %j",
  (projectMilestone) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const native = issue("ENG-7", {
        projectMilestone,
        comments: empty,
        history: empty,
        attachments: empty,
        reactions: [],
      });
      const test = fakeLinear({
        T3Issues: () => ({ organization: ORGANIZATION, issues: { ...empty, nodes: [native] } }),
        T3Issue: () => ({ issue: native }),
        T3Viewer: () => ({ viewer: JULIUS }),
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 20,
      });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
      const detail = yield* api.getIssue({ ...target, key: "ENG-7" });
      const milestone = projectMilestone?.name ?? null;
      for (const summary of [page.items[0]!, detail]) {
        expect(summary.milestone).toBe(milestone);
        const wire = yield* decodeIssueSummary({
          ...summary,
          tracker: IssueTrackerKind.make("linear"),
          host: target.host,
          scope: target.scope,
        });
        expect(wire.milestone).toBe(milestone);
      }
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3Issues",
        "T3Issue",
        "T3Viewer",
      ]);
      for (const request of test.requests.filter(({ operation }) => operation !== "T3Viewer"))
        expect(compactQuery(request.query)).toContain(compactQuery("projectMilestone { name }"));
    }),
);

describe("LinearIssueTracker", () => {
  it.effect("classifies native duplicates as closed without adding a writable close reason", () =>
    Effect.gen(function* () {
      const duplicate = state("Duplicate", "duplicate");
      const todo = state("Todo", "unstarted");
      const native = issue("ENG-7", {
        state: duplicate,
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        reactions: [],
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        history: {
          nodes: [
            [todo, duplicate],
            [duplicate, todo],
          ].map(([fromState, toState], index) => ({
            id: `history-${index}`,
            createdAt: "2026-07-01T00:00:00.000Z",
            actor: JULIUS,
            fromState,
            toState,
            fromAssignee: null,
            toAssignee: null,
            addedLabels: null,
            removedLabels: null,
            fromTitle: null,
            toTitle: null,
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issue: () => ({ issue: native }),
        T3Issues: () => ({
          organization: ORGANIZATION,
          issues: {
            nodes: [native],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      });
      const api = yield* test.tracker;
      const detail = yield* api.getIssue({ ...target, key: "ENG-7" });
      expect(detail.state).toMatchObject({
        category: "closed",
        name: "Duplicate",
        closeReason: "duplicate",
      });
      expect(detail.events.map((event) => event.kind)).toEqual(["closed", "reopened"]);
      for (const state of ["closed", "open"] as const) {
        const page = yield* api.listIssues({
          ...target,
          state,
          involvement: "all",
          viewer: JULIUS.id,
          limit: 50,
        });
        expect(page.items[0]?.state.category).toBe("closed");
        expect(test.requests.at(-1)?.variables.filter).toMatchObject({
          state: {
            type: { [state === "closed" ? "in" : "nin"]: ["completed", "canceled", "duplicate"] },
          },
        });
      }
      expect(api.capabilities.closeReasons).toEqual(["completed", "canceled"]);
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3Issue",
        "T3Viewer",
        "T3Issues",
        "T3Issues",
      ]);
    }),
  );
  it.effect("rejects the same team key in another workspace without extra native reads", () =>
    Effect.gen(function* () {
      const native = issue("ENG-7", {
        url: "https://linear.app/other/issue/ENG-7",
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        reactions: [],
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
      const other = { id: "org_other", urlKey: "other" };
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issues: () => ({
          organization: other,
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3Issue: () => ({ issue: native }),
        T3IssueReference: () => ({ issue: native }),
        T3Comments: () => ({ issue: native }),
        T3CommentTarget: () => ({ issue: native, comment: { id: "comment", issue: native } }),
        T3Team: () => ({
          organization: other,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG" };
      const operations = [
        [
          api.listIssues({
            ...scoped,
            state: "all",
            involvement: "all",
            viewer: JULIUS.id,
            limit: 20,
          }),
          ["T3Issues"],
        ],
        [api.create({ ...scoped, title: "New", body: "", labels: [], assignees: [] }), ["T3Team"]],
        [api.getIssue({ ...scoped, key: "ENG-7" }), ["T3Issue", "T3Viewer"]],
        [api.getComments({ ...scoped, key: "ENG-7" }), ["T3Comments"]],
        [api.comment({ ...scoped, key: "ENG-7", body: "Hello" }), ["T3IssueReference"]],
        [api.update({ ...scoped, key: "ENG-7", title: "Changed" }), ["T3IssueReference"]],
        [api.setState({ ...scoped, key: "ENG-7", state: "closed" }), ["T3IssueReference"]],
        [
          api.setReaction({ ...scoped, key: "ENG-7", content: "heart", reacted: true }),
          ["T3IssueReference"],
        ],
        [
          api.setReaction({
            ...scoped,
            key: "ENG-7",
            subjectId: "comment",
            content: "heart",
            reacted: true,
          }),
          ["T3CommentTarget"],
        ],
        [api.listCandidates(scoped), ["T3Team"]],
        [api.listTemplates(scoped), ["T3Team"]],
      ] as const;
      for (const [operation, expected] of operations) {
        test.requests.length = 0;
        expect((yield* operation.pipe(Effect.flip)).reason).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual(expected);
      }
    }),
  );
  it.effect("keeps viewer reads small and reports a partial credential catalog", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3ProbeCredential: () => ({
          organization: ORGANIZATION,
          viewer: JULIUS,
          teams: {
            nodes: [{ id: "team_eng", key: "ENG", name: "Engineering" }],
            pageInfo: { hasNextPage: true, endCursor: "more-teams" },
          },
        }),
        T3Scope: (variables) => ({
          organization: ORGANIZATION,
          teams: { nodes: [{ id: "team_hidden", key: variables.key, name: "Hidden team" }] },
        }),
      });
      const api = yield* test.tracker;
      expect(yield* api.getViewer(target)).toBe(JULIUS.id);
      expect(test.requests[0]?.query).not.toContain("teams(");
      const probe = yield* api.probeCredential("lin_api_probe");
      expect(probe.accountId).toBe(`org_acme/${JULIUS.id}`);
      expect(probe.scopesTruncated).toBe(true);
      expect(probe.scopes).toEqual([{ key: "acme/ENG", name: "Engineering" }]);
      expect(compactQuery(test.requests[1]?.query)).toContain(compactQuery("teams(first: 250)"));
      expect(yield* api.getScope("lin_api_probe", "hidden")).toEqual({
        key: "acme/HIDDEN",
        name: "Hidden team",
      });
      expect(yield* api.getScope("lin_api_probe", "acme/hidden")).toEqual({
        key: "acme/HIDDEN",
        name: "Hidden team",
      });
      expect(yield* api.getScope("lin_api_probe", "other/hidden")).toBeNull();
      expect(test.requests.map((request) => request.authorization)).toEqual([
        "lin_api_stored",
        "lin_api_probe",
        "lin_api_probe",
        "lin_api_probe",
        "lin_api_probe",
      ]);
    }),
  );
  it.effect("checks workspace again on the existing state query before mutation", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3TeamStates: () => ({
          organization: { id: "org_other", urlKey: "other" },
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: {
                  nodes: [state("Done", "completed")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
          },
        }),
      });
      const api = yield* test.tracker;
      const error = yield* api
        .setState({ ...target, scope: "acme/ENG", key: "ENG-7", state: "closed" })
        .pipe(Effect.flip);
      expect(error.detail).toContain("workspace");
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3TeamStates",
      ]);
    }),
  );
  it.effect("clamps issue lists and marks partial preview labels", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Issues: () => ({
          organization: ORGANIZATION,
          issues: {
            nodes: [
              issue("ENG-1", {
                labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-labels" } },
              }),
              issue("ENG-2"),
            ],
            pageInfo: { hasNextPage: true, endCursor: "more-issues" },
          },
        }),
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 200,
      });
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.variables.first).toBe(100);
      expect(compactQuery(test.requests[0]?.query)).toContain(
        compactQuery("labels(first: 20, includeArchived: true)"),
      );
      expect(page.items[0]?.labelsTruncated).toBe(true);
      expect(page.items.map((item) => item.commentCount)).toEqual([null, null]);
      expect(page.nextCursor).toBe("more-issues");
    }),
  );
  it.effect.each(["ENG", "acme/ENG"])(
    "writes a comment with scope %s after one small lookup",
    (scope) =>
      Effect.gen(function* () {
        const test = fakeLinear({
          T3IssueReference: () => ({
            issue: {
              id: "iss_native",
              identifier: "ENG-7",
              url: "https://linear.app/acme/issue/ENG-7",
              team: { key: "ENG" },
            },
          }),
          T3CommentCreate: (variables) => {
            expect(variables.input).toEqual({ issueId: "iss_native", body: "Comment" });
            return { commentCreate: { success: true } };
          },
        });
        const api = yield* test.tracker;
        yield* api.comment({ ...target, scope, key: "eng-7", body: "Comment" });
        expect(test.requests.map((request) => request.operation)).toEqual([
          "T3IssueReference",
          "T3CommentCreate",
        ]);
        expect(test.requests[0]?.query).not.toMatch(
          /history|attachments|comments|labels|description/u,
        );
      }),
  );
  it.effect("rejects a moved issue before a comment write", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "OTHER-7",
            url: "https://linear.app/acme/issue/OTHER-7",
            team: { key: "OTHER" },
          },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api.comment({ ...target, key: "ENG-7", body: "Comment" }).pipe(Effect.flip)).reason,
      ).toBe("failed");
      expect(test.requests.map((request) => request.operation)).toEqual(["T3IssueReference"]);
    }),
  );
  it.effect("resolves issue and comment in one small query before a reaction", () =>
    Effect.gen(function* () {
      const reference = {
        id: "iss_native",
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7",
        team: { key: "ENG" },
      };
      const test = fakeLinear({
        T3CommentTarget: () => ({
          issue: reference,
          comment: { id: "cmt_native", issue: reference },
        }),
        T3ReactionCreate: (variables) => {
          expect(variables.input).toEqual({ commentId: "cmt_native", emoji: "👍" });
          return { reactionCreate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      yield* api.setReaction({
        ...target,
        key: "ENG-7",
        subjectId: "cmt_native",
        content: "thumbs-up",
        reacted: true,
      });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3CommentTarget",
        "T3ReactionCreate",
      ]);
      expect(test.requests[0]?.query).not.toMatch(
        /history|attachments|comments\(|labels|description/u,
      );
    }),
  );
  it.effect("cannot react to a comment on another issue or team", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3CommentTarget: () => ({
          issue: {
            id: "iss_eng",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
          comment: {
            id: "cmt_foreign",
            issue: {
              id: "iss_other",
              identifier: "OTHER-7",
              url: "https://linear.app/acme/issue/OTHER-7",
              team: { key: "OTHER" },
            },
          },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api
          .setReaction({
            ...target,
            key: "ENG-7",
            subjectId: "cmt_foreign",
            content: "thumbs-up",
            reacted: true,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("not-found");
      expect(test.requests.map((request) => request.operation)).toEqual(["T3CommentTarget"]);
    }),
  );
  it.effect("rejects foreign and moved native teams before edits or state writes", () =>
    Effect.gen(function* () {
      for (const key of ["OPS-7", "ENG-7"]) {
        const test = fakeLinear({
          T3IssueReference: () => ({
            issue: {
              id: "iss_ops",
              identifier: "OPS-7",
              url: "https://linear.app/acme/issue/OPS-7",
              team: { key: "OPS" },
            },
          }),
          T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
        });
        const api = yield* test.tracker;
        expect(
          (yield* api.update({ ...target, key, title: "Changed" }).pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(
          (yield* api.setState({ ...target, key, state: "closed" }).pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual([
          "T3IssueReference",
          "T3IssueReference",
        ]);
      }
    }),
  );
  it.effect("checks the returned native team before exposing issue or comment data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issue: () => ({
          issue: issue("OPS-7", {
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            reactions: [],
            attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
        }),
        T3Comments: () => ({
          issue: {
            id: "iss_ops",
            identifier: "OPS-7",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
        T3IssueReference: () => ({
          issue: {
            id: "iss_ops",
            identifier: "OPS-7",
            url: "https://linear.app/acme/issue/OPS-7",
            team: { key: "OPS" },
          },
        }),
      });
      const api = yield* test.tracker;
      expect((yield* api.getIssue({ ...target, key: "ENG-7" }).pipe(Effect.flip)).reason).toBe(
        "failed",
      );
      expect(
        (yield* api.getComments({ ...target, key: "ENG-7", cursor: "next" }).pipe(Effect.flip))
          .reason,
      ).toBe("failed");
      const before = test.requests.length;
      expect(yield* api.getViewerPermissions({ ...target, key: "ENG-7" })).toMatchObject({
        comment: true,
        edit: true,
      });
      expect(test.requests).toHaveLength(before);
    }),
  );
  it.effect("edits a moved identifier with the verified native issue UUID", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3IssueUpdate: (variables) => {
          expect(variables).toEqual({ id: "iss_native", input: { title: "Changed" } });
          return { issueUpdate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      yield* api.update({ ...target, key: "OPS-7", title: "Changed" });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3IssueUpdate",
      ]);
    }),
  );
  it.effect("rejects a mentions filter before any native request", () =>
    Effect.gen(function* () {
      const test = fakeLinear({});
      const api = yield* test.tracker;
      const error = yield* api
        .listIssues({
          ...target,
          state: "all",
          involvement: "mentioned",
          viewer: JULIUS.id,
          limit: 20,
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("mentions");
      expect(test.requests).toHaveLength(0);
    }),
  );
  it.effect("keeps full reaction counts with bounded actor names and honest detail flags", () =>
    Effect.gen(function* () {
      const nativeReactions = Array.from({ length: 100 }, (_, index) => ({
        id: `reaction-${index}`,
        emoji: "👍",
        user: user(`user-${index}`, `user-${index}`),
      }));
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3Issue: () => ({
          issue: issue("ENG-7", {
            labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-labels" } },
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "Comment",
                  createdAt: "2026-07-01T00:00:00.000Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment",
                  editedAt: null,
                  user: THEO,
                  reactions: nativeReactions,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            reactions: nativeReactions,
            attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            history: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-history" } },
          }),
        }),
      });
      const api = yield* test.tracker;
      const detail = yield* api.getIssue({ ...target, key: "ENG-7" });
      expect(detail.commentCount).toBe(1);
      expect(detail.labelsTruncated).toBe(true);
      expect(detail.historyTruncated).toBe(true);
      expect(detail.reactionsTruncated).toBe(true);
      expect(detail.reactions?.[0]?.count).toBe(100);
      expect(detail.reactions?.[0]?.actors).toHaveLength(20);
      expect(detail.comments[0]?.reactionsTruncated).toBe(true);
      expect(detail.comments[0]?.reactions?.[0]?.count).toBe(100);
      expect(
        compactQuery(test.requests.find((request) => request.operation === "T3Issue")?.query),
      ).toContain(compactQuery("labels(first: 100, includeArchived: true)"));
      expect(
        compactQuery(test.requests.find((request) => request.operation === "T3Issue")?.query),
      ).toContain(compactQuery("history(first: 100"));
    }),
  );
  it.effect("uses only exhausted native windows for the reset", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const { api } = fakeLinear({
        T3Viewer: () =>
          new Response("limited", {
            status: 429,
            headers: {
              "x-ratelimit-requests-reset": String(now + 30_000),
              "x-ratelimit-requests-remaining": "10",
              "x-ratelimit-complexity-reset": String(now + 3_600_000),
              "x-ratelimit-complexity-remaining": "10",
              "x-ratelimit-endpoint-requests-reset": String(now + 90_000),
              "x-ratelimit-endpoint-requests-remaining": "0",
              "x-ratelimit-endpoint-name": "native-viewer-limit",
              "retry-after": "5",
            },
          }),
      });
      const native = yield* api;
      const error = yield* native.viewer().pipe(Effect.flip);
      expect(error.reason).toBe("rate-limited");
      expect(error.retryAt).toBe(now + 90_000);
    }),
  );
  it.effect("keeps Retry-After separate and ignores invalid native reset times", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const { api } = fakeLinear({
        T3Viewer: () =>
          new Response("limited", {
            status: 429,
            headers: {
              "x-ratelimit-requests-reset": "not-a-timestamp",
              "x-ratelimit-complexity-reset": String(now - 1),
              "x-ratelimit-endpoint-requests-reset": "Infinity",
              "retry-after": "20",
            },
          }),
      });
      const native = yield* api;
      const error = yield* native.viewer().pipe(Effect.flip);
      expect(error.retryAt).toBe(now + 20_000);
    }),
  );
  it.effect("shares pauses across verified same-user keys and isolates another user", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      let limited = true;
      const test = fakeLinear({
        T3ProbeCredential: () => ({
          viewer: test.requests.at(-1)?.authorization === "lin_api_other" ? THEO : JULIUS,
          organization: ORGANIZATION,
          teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3Viewer: () =>
          limited
            ? new Response("limited", {
                status: 429,
                headers: {
                  "x-ratelimit-requests-reset": String(now + 60_000),
                  "x-ratelimit-requests-remaining": "0",
                },
              })
            : { viewer: test.requests.at(-1)?.authorization === "lin_api_other" ? THEO : JULIUS },
      });
      const native = yield* test.api;
      yield* native.probeCredential("lin_api_stored");
      yield* native.probeCredential("lin_api_changed");
      yield* native.viewer().pipe(Effect.flip);
      limited = false;
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(3);
      test.setToken("lin_api_changed");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(3);
      expect((yield* native.probeCredential("lin_api_unseen").pipe(Effect.flip)).reason).toBe(
        "rate-limited",
      );
      expect(test.requests).toHaveLength(4);
      yield* native.probeCredential("lin_api_other");
      test.setToken("lin_api_other");
      yield* native.viewer();
      expect(test.requests).toHaveLength(6);
      test.setToken("lin_api_stored");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(6);
      yield* TestClock.adjust("60 seconds");
      expect((yield* native.viewer()).viewer.id).toBe(JULIUS.id);
      expect(test.requests).toHaveLength(7);
    }),
  );
  it.effect("pauses a named endpoint without blocking viewer or unrelated operations", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      let limited = true;
      const test = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3CommentCreate: () => ({ commentCreate: { success: true } }),
        T3Issues: () =>
          limited
            ? Response.json(
                { errors: [{ message: "Limited", extensions: { code: "RATELIMITED" } }] },
                {
                  status: 400,
                  headers: {
                    "x-ratelimit-requests-remaining": "100",
                    "x-ratelimit-requests-reset": String(now + 3_600_000),
                    "x-ratelimit-complexity-remaining": "100",
                    "x-ratelimit-complexity-reset": String(now + 3_600_000),
                    "x-ratelimit-endpoint-requests-remaining": "0",
                    "x-ratelimit-endpoint-requests-reset": String(now + 60_000),
                    "x-ratelimit-endpoint-name": "native-issue-list-limit",
                  },
                },
              )
            : {
                organization: ORGANIZATION,
                issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
      });
      const native = yield* test.api;
      expect((yield* native.listIssues({ filter: {}, first: 20 }).pipe(Effect.flip)).retryAt).toBe(
        now + 60_000,
      );
      limited = false;
      yield* native.viewer();
      yield* native.getIssueReference("ENG-7");
      yield* native.createComment({ issueId: "iss_native", body: "Comment" });
      expect((yield* native.listIssues({ filter: {}, first: 20 }).pipe(Effect.flip)).reason).toBe(
        "rate-limited",
      );
      expect(test.requests).toHaveLength(4);
      yield* TestClock.adjust("60 seconds");
      yield* native.listIssues({ filter: {}, first: 20 });
      expect(test.requests).toHaveLength(5);
    }),
  );
  it.effect("records zero remaining quota on a successful response before another request", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json(
            { data: { viewer: JULIUS } },
            {
              headers: {
                "x-ratelimit-requests-remaining": "0",
                "x-ratelimit-requests-reset": String(now + 60_000),
                "x-ratelimit-complexity-remaining": "10",
                "x-ratelimit-complexity-reset": String(now + 3_600_000),
              },
            },
          ),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
      });
      const native = yield* test.api;
      yield* native.viewer();
      expect((yield* native.getIssueReference("ENG-7").pipe(Effect.flip)).retryAt).toBe(
        now + 60_000,
      );
      expect(test.requests).toHaveLength(1);
      yield* TestClock.adjust("60 seconds");
      yield* native.getIssueReference("ENG-7");
      expect(test.requests).toHaveLength(2);
    }),
  );
  it.effect(
    "shares a learned native endpoint across documents and keeps successful zero quotas",
    () =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        const nativeIssue = issue("ENG-7", {
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        });
        const headers = {
          "x-ratelimit-endpoint-name": "native-common-limit",
          "x-ratelimit-endpoint-requests-reset": String(now + 30_000),
        };
        const test = fakeLinear({
          T3Comments: () =>
            Response.json(
              { data: { issue: nativeIssue } },
              { headers: { ...headers, "x-ratelimit-endpoint-requests-remaining": "5" } },
            ),
          T3IssueReference: () =>
            Response.json(
              { data: { issue: nativeIssue } },
              { headers: { ...headers, "x-ratelimit-endpoint-requests-remaining": "0" } },
            ),
          T3Viewer: () => ({ viewer: JULIUS }),
        });
        const native = yield* test.api;
        const input = { identifier: "ENG-7", first: 50, after: "next" };
        yield* native.getComments(input);
        yield* native.getIssueReference("ENG-7");
        expect((yield* native.getComments(input).pipe(Effect.flip)).retryAt).toBe(now + 30_000);
        yield* native.viewer();
        expect((yield* native.getComments(input).pipe(Effect.flip)).reason).toBe("rate-limited");
        expect(test.requests).toHaveLength(3);
        yield* TestClock.adjust("30 seconds");
        yield* native.getComments(input);
        expect(test.requests).toHaveLength(4);
      }),
  );
  it.effect.each([false, true])(
    "uses a conservative global pause when endpoint identity is missing: %s",
    (endpointOnly) =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        let limited = true;
        const pauseSeconds = endpointOnly ? 60 : 30;
        const test = fakeLinear({
          T3Viewer: () =>
            limited
              ? new Response("", {
                  status: 429,
                  headers: {
                    "x-ratelimit-requests-reset": String(now + 3_600_000),
                    ...(endpointOnly
                      ? {
                          "x-ratelimit-requests-remaining": "10",
                          "x-ratelimit-endpoint-requests-remaining": "0",
                          "x-ratelimit-endpoint-requests-reset": String(now + 60_000),
                        }
                      : {}),
                  },
                })
              : { viewer: JULIUS },
        });
        const native = yield* test.api;
        expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
        limited = false;
        expect((yield* native.viewer().pipe(Effect.flip)).retryAt).toBe(now + pauseSeconds * 1_000);
        expect(test.requests).toHaveLength(1);
        yield* TestClock.adjust(`${pauseSeconds} seconds`);
        yield* native.viewer();
        expect(test.requests).toHaveLength(2);
      }),
  );
  it.effect("records GraphQL rate limits before any later HTTP request", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json(
            { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] },
            { status: 400, headers: { "retry-after": "10" } },
          ),
      });
      const native = yield* test.api;
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect((yield* native.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(1);
    }),
  );
  it.effect("keeps response read failures free of raw transport secrets", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("fake-api-key"));
              },
            }),
          ),
      });
      const api = yield* test.api;
      const error = yield* api.viewer().pipe(Effect.flip);
      expect(error.detail).toBe("Linear response could not be read.");
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("fake-api-key");
    }),
  );

  it.effect.each([{}, { other: { success: true } }, { issueUpdate: { success: false } }])(
    "refuses a mutation without its named success result: %j",
    (data) =>
      Effect.gen(function* () {
        const test = fakeLinear({ T3IssueUpdate: () => data });
        const api = yield* test.api;
        const error = yield* api
          .updateIssue("native-issue", { title: "New title" })
          .pipe(Effect.flip);
        expect(error.detail).toBe("Linear did not apply the change.");
      }),
  );

  it.effect("ends a stalled Linear response within the request budget", () =>
    Effect.gen(function* () {
      const test = fakeLinear({ T3Viewer: () => new Response(new ReadableStream()) });
      const api = yield* test.api;
      const fiber = yield* api.viewer().pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.detail).toBe("Linear request timed out.");
    }),
  );

  it.effect("refuses a Linear response above the body budget", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () => new Response(" ".repeat(4 * 1024 * 1024 + 1)),
      });
      const api = yield* test.api;
      const error = yield* api.viewer().pipe(Effect.flip);
      expect(error.reason).toBe("failed");
      expect(error.detail).toBe("Linear returned an oversized or invalid response.");
    }),
  );

  it.effect.each([300, 400, 404, 500, 503])(
    "rejects HTTP %s even when it includes valid data",
    (status) =>
      Effect.gen(function* () {
        const test = fakeLinear({
          T3Viewer: () => Response.json({ data: { viewer: JULIUS } }, { status }),
        });
        const api = yield* test.api;
        const error = yield* api.viewer().pipe(Effect.flip);
        expect(error.reason).toBe("failed");
        expect(error.detail).toBe(`Linear returned HTTP ${status}.`);
        expect(test.requests).toHaveLength(1);
      }),
  );

  it.effect.each([
    { name: "input", code: "BAD_USER_INPUT", detail: "Linear rejected the request input." },
    {
      name: "validation",
      code: "GRAPHQL_VALIDATION_FAILED",
      detail: "Linear rejected the request input.",
    },
    { name: "forbidden", code: "FORBIDDEN", detail: "Linear denied access to this resource." },
    {
      name: "internal",
      code: "INTERNAL_SERVER_ERROR",
      detail: "Linear could not complete the request.",
    },
    { name: "unknown", code: "UNKNOWN_NATIVE_CODE", detail: "Linear returned HTTP 200." },
    { name: "missing", code: undefined, detail: "Linear returned HTTP 200." },
    {
      name: "oversized",
      code: "BAD_USER_INPUT" + "x".repeat(131_072),
      detail: "Linear returned HTTP 200.",
    },
    { name: "prototype", code: "__proto__", detail: "Linear returned HTTP 200." },
    { name: "unrecognized casing", code: "bad_user_input", detail: "Linear returned HTTP 200." },
  ])(
    "normalizes GraphQL $name codes and preserves raw diagnostics only in cause",
    ({ code, detail }) =>
      Effect.gen(function* () {
        const payload = {
          errors: [
            {
              message: "private-wire-marker " + "x".repeat(131_072),
              extensions: { code, diagnostic: "private-extension" },
              path: ["private-path"],
            },
          ],
          extensions: { trace: "private-trace" },
        };
        const test = fakeLinear({ T3Viewer: () => Response.json(payload) });
        const api = yield* test.api;
        const error = yield* api.viewer().pipe(Effect.flip);
        expect(error.detail.length).toBeLessThan(160);
        expect(error).toMatchObject({ operation: "viewer", reason: "failed", detail });
        expect(error.message).toBe(`linear failed in viewer: ${detail}`);
        expect(JSON.stringify({ ...error, cause: undefined })).not.toContain("private-");
        expect(error.cause).toBe(JSON.stringify(payload));
        expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Viewer"]);
      }),
  );

  it.effect.each(["RATELIMITED", "AUTHENTICATION_ERROR"])(
    "keeps GraphQL %s classification and raw cause without extra requests",
    (code) =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        const payload = { errors: [{ message: "private-graphql-marker", extensions: { code } }] };
        const test = fakeLinear({
          T3Viewer: () =>
            Response.json(payload, {
              status: 400,
              headers: { "retry-after": "10" },
            }),
        });
        const api = yield* test.api;
        const error = yield* api.viewer().pipe(Effect.flip);
        expect(error.reason).toBe(code === "RATELIMITED" ? "rate-limited" : "unauthenticated");
        expect(error.detail).toBe(
          code === "RATELIMITED"
            ? "Linear's rate limit was reached."
            : "Linear rejected the API key.",
        );
        expect(error.cause).toBe(JSON.stringify(payload));
        if (code === "RATELIMITED") {
          expect(error.retryAt).toBe(now + 10_000);
          expect((yield* api.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
        }
        expect(test.requests).toHaveLength(1);
      }),
  );

  it.effect.each(
    [401, 403, 429].flatMap((status) =>
      ["application/json", "application/graphql-response+json"].map((contentType) => ({
        status,
        contentType,
      })),
    ),
  )("does not read native HTTP $status $contentType bodies", ({ status, contentType }) =>
    Effect.gen(function* () {
      let reads = 0;
      const test = fakeLinear({
        T3Viewer: () =>
          new Response(
            new ReadableStream(
              {
                pull() {
                  reads++;
                  throw new Error("private-unread-body");
                },
              },
              { highWaterMark: 0 },
            ),
            { status, headers: { "retry-after": "10", "content-type": contentType } },
          ),
      });
      const api = yield* test.api;
      const error = yield* api.viewer().pipe(Effect.flip);
      expect(error.reason).toBe(status === 429 ? "rate-limited" : "unauthenticated");
      expect(error.cause).toBeUndefined();
      expect(reads).toBe(0);
      expect(test.requests).toHaveLength(1);
    }),
  );

  it.effect("normalizes mutation GraphQL failures without another native request", () =>
    Effect.gen(function* () {
      const payload = {
        errors: [{ message: "private-mutation-marker", extensions: { code: "BAD_USER_INPUT" } }],
      };
      const test = fakeLinear({ T3IssueUpdate: () => Response.json(payload) });
      const api = yield* test.api;
      const error = yield* api
        .updateIssue("native-issue", { title: "New title" })
        .pipe(Effect.flip);
      expect(error.detail).toBe("Linear rejected the request input.");
      expect(error.cause).toBe(JSON.stringify(payload));
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3IssueUpdate"]);
    }),
  );

  it.effect.each([200, 400])(
    "classifies native missing issues on HTTP %s before normalization",
    (status) =>
      Effect.gen(function* () {
        const payload = {
          data: null,
          errors: [
            {
              message: "Entity not found: Issue - Could not find referenced Issue. private-marker",
              extensions: { code: "INPUT_ERROR" },
            },
          ],
        };
        const test = fakeLinear({
          T3Issue: () => Response.json(payload, { status }),
          T3IssueReference: () => Response.json(payload, { status }),
          T3Viewer: () => ({ viewer: JULIUS }),
        });
        const native = yield* test.api;
        const lookups = yield* Effect.all([
          native.getIssue("ENG-404", 10).pipe(Effect.result),
          native.getIssueReference("ENG-404").pipe(Effect.result),
        ]);
        const tracker = yield* test.tracker;
        for (const action of [
          tracker.getIssue({ ...target, key: "ENG-404" }),
          tracker.comment({ ...target, key: "ENG-404", body: "New comment" }),
        ]) {
          const error = yield* action.pipe(Effect.flip);
          expect(error.reason).toBe("not-found");
          expect(error.detail).toBe(
            "Linear has no issue by that identifier, or this account cannot see it.",
          );
          expect(JSON.stringify(error)).not.toContain("private-marker");
        }
        expect(
          lookups.map((result) =>
            result._tag === "Success" ? result.success : result.failure.reason,
          ),
        ).toEqual([null, null]);
        expect(test.requests.map(({ operation }) => operation).sort()).toEqual([
          "T3Issue",
          "T3Issue",
          "T3IssueReference",
          "T3IssueReference",
          "T3Viewer",
        ]);
      }),
  );

  it.effect.each([
    {
      name: "generic",
      errors: [
        { message: "Something not found: private-marker", extensions: { code: "UNKNOWN_CODE" } },
      ],
      status: 200,
    },
    {
      name: "other entity",
      errors: [{ message: "Entity not found: IssueLabel - private-marker" }],
      status: 200,
    },
    { name: "server failure", errors: [{ message: "Entity not found: Issue" }], status: 500 },
    {
      name: "mixed errors",
      errors: [
        { message: "Entity not found: Issue" },
        { message: "Another failure: private-marker" },
      ],
      status: 200,
    },
    {
      name: "partial data",
      errors: [{ message: "Entity not found: Issue" }],
      status: 200,
      data: { issue: issue("ENG-7") },
    },
    {
      name: "authentication",
      errors: [
        { message: "Entity not found: Issue", extensions: { code: "AUTHENTICATION_ERROR" } },
      ],
      status: 400,
      reason: "unauthenticated",
    },
    {
      name: "rate limit",
      errors: [{ message: "Entity not found: Issue", extensions: { code: "RATELIMITED" } }],
      status: 400,
      reason: "rate-limited",
    },
  ])(
    "keeps $name lookup errors distinct from a missing issue",
    ({ errors, status, data, reason }) =>
      Effect.gen(function* () {
        for (const operation of ["T3Issue", "T3IssueReference"]) {
          const payload = { data: data ?? null, errors };
          const test = fakeLinear({
            [operation]: () => Response.json(payload, { status, headers: { "retry-after": "10" } }),
          });
          const native = yield* test.api;
          const action =
            operation === "T3Issue"
              ? native.getIssue("ENG-404", 10)
              : native.getIssueReference("ENG-404");
          const error = yield* action.pipe(Effect.flip);
          expect(error.reason).toBe(reason ?? "failed");
          expect(error.cause).toBe(JSON.stringify(payload));
          expect(error.detail).not.toContain("private-marker");
          expect(test.requests.map(({ operation }) => operation)).toEqual([operation]);
        }
      }),
  );

  it.effect("keeps native missing-issue messages as failures outside issue lookups", () =>
    Effect.gen(function* () {
      const payload = {
        data: null,
        errors: [
          {
            message: "Entity not found: Issue - private-marker",
            extensions: { code: "INPUT_ERROR" },
          },
        ],
      };
      const test = fakeLinear({
        T3Viewer: () => Response.json(payload),
        T3IssueUpdate: () => Response.json(payload),
      });
      const native = yield* test.api;
      for (const action of [
        native.viewer(),
        native.updateIssue("ENG-404", { title: "New title" }),
      ]) {
        const error = yield* action.pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "failed",
          detail: "Linear returned HTTP 200.",
          cause: JSON.stringify(payload),
        });
      }
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3Viewer",
        "T3IssueUpdate",
      ]);
    }),
  );

  it.effect("rejects GraphQL errors even with otherwise valid partial data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json({
            data: { viewer: JULIUS },
            errors: [{ message: "A field could not be read." }],
          }),
      });
      const api = yield* test.api;
      const error = yield* api.viewer().pipe(Effect.flip);
      expect(error.detail).toBe("Linear returned HTTP 200.");
      expect(error.cause).toContain("A field could not be read.");
    }),
  );
  it.effect.each(["template-data", "template-count", "ancestor-count"] as const)(
    "keeps quota backoff after invalid decoded team %s",
    (invalid) =>
      Effect.gen(function* () {
        const now = 1_750_000_000_000;
        yield* TestClock.setTime(now);
        const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const template = {
          id: "template",
          name: "Template",
          description: null,
          content: null,
          type: "issue",
          hasFormFields: false,
          templateData: invalid === "template-data" ? "{" : {},
        };
        const test = fakeLinear({
          T3Viewer: () => new Response(null, { status: 429 }),
          T3Team: () => ({
            organization: ORGANIZATION,
            issueLabels: empty,
            teams: {
              nodes: [
                {
                  id: "team",
                  key: "ENG",
                  name: "Engineering",
                  private: false,
                  visibility: "public",
                  restrictedBy: null,
                  states: empty,
                  labels: empty,
                  members: empty,
                  templates: {
                    ...empty,
                    nodes: Array.from(
                      { length: invalid === "template-count" ? 101 : 1 },
                      () => template,
                    ),
                  },
                  ancestors:
                    invalid === "ancestor-count"
                      ? Array.from({ length: 6 }, (_, index) => ({
                          id: `ancestor-${index}`,
                          key: `A${index}`,
                          name: "Ancestor",
                          private: false,
                          visibility: "public",
                          restrictedBy: null,
                          templates: empty,
                        }))
                      : [],
                },
              ],
            },
          }),
        });
        const api = yield* test.api;
        yield* api.viewer().pipe(Effect.flip);
        const first = yield* api.viewer().pipe(Effect.flip);
        const cooldown = first.retryAt! - now;
        expect(cooldown).toBeGreaterThan(0);
        yield* TestClock.adjust(cooldown);
        expect((yield* api.getTeam("ENG").pipe(Effect.flip)).reason).toBe("failed");
        yield* api.viewer().pipe(Effect.flip);
        const second = yield* api.viewer().pipe(Effect.flip);
        expect(second.retryAt! - (now + cooldown)).toBeGreaterThan(cooldown);
        expect(test.requests.map(({ operation }) => operation)).toEqual([
          "T3Viewer",
          "T3Team",
          "T3Viewer",
        ]);
      }),
  );

  it.effect("rejects invalid UTF-8 before decoding native data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({ T3Viewer: () => new Response(Uint8Array.of(0xff)) });
      const api = yield* test.api;
      expect((yield* api.viewer().pipe(Effect.flip)).detail).toBe(
        "Linear returned an oversized or invalid response.",
      );
      expect(test.requests).toHaveLength(1);
    }),
  );

  it.effect("does not promote a viewer identity from malformed native data", () =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const test = fakeLinear(
        {
          T3ProbeCredential: () =>
            Response.json(
              { data: { viewer: JULIUS } },
              {
                headers: {
                  "x-ratelimit-requests-remaining": "0",
                  "x-ratelimit-requests-reset": String(now + 60_000),
                },
              },
            ),
          T3Viewer: () => ({ viewer: JULIUS }),
        },
        "lin_first",
      );
      const api = yield* test.api;
      expect((yield* api.probeCredential("lin_first").pipe(Effect.flip)).reason).toBe("failed");
      expect((yield* api.viewer("lin_second")).viewer.id).toBe(JULIUS.id);
      expect((yield* api.viewer("lin_first").pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(2);
    }),
  );

  it.effect("records rate errors before decoding incomplete native data", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Viewer: () =>
          Response.json({
            data: { viewer: null },
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          }),
      });
      const api = yield* test.api;
      expect((yield* api.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect((yield* api.viewer().pipe(Effect.flip)).reason).toBe("rate-limited");
      expect(test.requests).toHaveLength(1);
    }),
  );
  it.effect("fails reaction removal when the viewer cannot be read", () =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3Viewer: () => Response.json({ errors: [{ message: "Unavailable" }] }, { status: 500 }),
        T3IssueReactions: () => ({
          issue: { reactions: [{ id: "my_reaction", emoji: "👍", user: JULIUS }] },
        }),
      });
      const api = yield* test.tracker;
      expect(
        (yield* api
          .setReaction({ ...target, key: "ENG-7", content: "thumbs-up", reacted: false })
          .pipe(Effect.flip)).reason,
      ).toBe("failed");
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3Viewer",
      ]);
    }),
  );
  it.effect.each([
    { scope: "acme/OPS", query: "ENG-12", numbered: false },
    { scope: "acme/OPS", query: "eng-12", numbered: false },
    { scope: "ENG", query: "ENG-12", numbered: true },
    { scope: "acme/ENG", query: "eng-12", numbered: true },
    { scope: "acme/ENG", query: "12", numbered: true },
    { scope: "acme/OPS", query: "12", numbered: true },
    { scope: "acme/ENG", query: "#12", numbered: true },
    { scope: "acme/OPS", query: "#12", numbered: true },
    { scope: "acme/ENG", query: " ENG-12 ", numbered: true },
    { scope: "acme/ENG", query: "OTHER-12", numbered: false },
    { scope: "acme/ENG", query: "ENG-12x", numbered: false },
    { scope: "acme/ENG", query: "ENG-#12", numbered: false },
    { scope: "acme/ENG", query: "fix ENG-12", numbered: false },
  ])("searches $query within $scope without dropping its team", ({ scope, query, numbered }) =>
    Effect.gen(function* () {
      const team = scope.split("/").at(-1)!;
      const textMatch = issue(`${team}-99`, { title: query });
      const test = fakeLinear({
        T3Issues: (variables) => {
          const filter = variables.filter as {
            or: Array<{ number?: { eq: number } }>;
          };
          return {
            organization: ORGANIZATION,
            issues: {
              nodes: [
                textMatch,
                ...(filter.or.some((branch) => branch.number?.eq === 12)
                  ? [issue(`${team}-12`)]
                  : []),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        scope,
        query,
        state: "all",
        involvement: "all",
        viewer: JULIUS.id,
        limit: 20,
      });
      expect(test.requests.map((request) => request.operation)).toEqual(["T3Issues"]);
      expect(test.requests[0]?.variables.filter).toEqual({
        team: { key: { eq: team } },
        or: [
          { title: { containsIgnoreCase: query } },
          { description: { containsIgnoreCase: query } },
          ...(numbered ? [{ number: { eq: 12 } }] : []),
        ],
      });
      expect(page.items.map((item) => item.key)).toEqual([
        `${team}-99`,
        ...(numbered ? [`${team}-12`] : []),
      ]);
    }),
  );

  it.effect.each(["ENG", "acme/ENG"])("lists summaries with scope %s in one request", (scope) =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS, teams: { nodes: [] } }),
        T3Issues: (variables) => {
          expect(variables.filter).toMatchObject({
            team: { key: { eq: "ENG" } },
            state: { type: { nin: ["completed", "canceled", "duplicate"] } },
            assignee: { id: { eq: "usr_julius" } },
          });
          return {
            organization: ORGANIZATION,
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
        scope,
        state: "open",
        involvement: "assigned",
        viewer: "usr_julius",
        limit: 50,
      });
      expect(page.nextCursor).toBe("cur_2");
      expect(page.items.map((item) => [item.key, item.displayKey, item.state])).toMatchObject([
        ["ENG-2", "ENG-2", { category: "closed", name: "Done", closeReason: "completed" }],
        ["ENG-1", "ENG-1", { category: "open", name: "In Progress" }],
      ]);
      expect(page.items[0]).toMatchObject({
        closedAt: "2026-07-03T00:00:00.000Z",
        author: { id: "usr_julius", login: "julius", name: "julius" },
        assignees: [{ id: "usr_theo", login: "theo", name: "theo" }],
        labels: [{ id: "lbl_bug", name: "Bug", color: "#f00" }],
      });
      // The stored key goes in as-is, not as a bearer token.
      expect(requests.map((request) => request.authorization)).toEqual(["lin_api_stored"]);
    }),
  );

  it.effect("reads an issue with its comments, reactions, history and linked pull requests", () =>
    Effect.gen(function* () {
      const { tracker, requests } = fakeLinear({
        T3Viewer: () => ({ viewer: JULIUS, teams: { nodes: [] } }),
        T3Issue: () => ({
          issue: issue("ENG-7", {
            comments: {
              nodes: [
                {
                  id: "cmt_1",
                  body: "hi",
                  createdAt: "2026-07-02T01:00:00.000Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment",
                  editedAt: null,
                  user: THEO,
                  reactions: [{ id: "r1", emoji: "👍", user: JULIUS }],
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cmt_cur" },
            },
            reactions: [
              { id: "r2", emoji: "🚀", user: THEO },
              { id: "r3", emoji: "🚀", user: JULIUS },
              { id: "r4", emoji: "🤷", user: THEO },
            ],
            attachments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  url: "https://github.com/acme/web/pull/12",
                  title: "Fix it",
                  sourceType: "github",
                  metadata: { status: "merged" },
                },
                ...[
                  null,
                  {},
                  { status: "unknown" },
                  { status: "open" },
                  { status: "draft" },
                  { status: "closed" },
                ].map((metadata, index) => ({
                  url: `https://gitlab.com/acme/web/-/merge_requests/${index + 1}`,
                  title: `Change ${index + 1}`,
                  sourceType: "gitlab",
                  metadata: metadata ?? {},
                })),
                { url: "https://example.test/doc", title: "Doc", sourceType: null, metadata: {} },
              ],
            },
            history: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "h1",
                  createdAt: "2026-07-01T01:00:00.000Z",
                  actor: THEO,
                  fromState: state("Todo", "unstarted"),
                  toState: state("Done", "completed"),
                  fromAssignee: null,
                  toAssignee: JULIUS,
                  addedLabels: [labelFixture({ id: "lbl_bug", name: "Bug", color: "#000" })],
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
      expect(detail.commentCount).toBeNull();
      expect(requests.filter((request) => request.operation === "T3Issue")).toHaveLength(1);
      expect(detail.author).toMatchObject({ id: JULIUS.id, login: "julius" });
      expect(detail.assignees[0]).toMatchObject({ id: THEO.id, login: "theo" });
      expect(detail.comments[0]?.author).toMatchObject({ id: THEO.id, login: "theo" });
      expect(detail.viewer).toBe("usr_julius");
      expect(JSON.parse(detail.commentsCursor!)[1]).toBe("cmt_cur");
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
      expect(detail.linkedPullRequests).toEqual([
        expect.objectContaining({
          repository: "acme/web",
          provider: "github",
          host: "github.com",
          number: 12,
          state: "merged",
        }),
        ...[null, null, null, "open", "open", "closed"].map((state, index) =>
          expect.objectContaining({
            provider: "gitlab",
            host: "gitlab.com",
            repository: "acme/web",
            number: index + 1,
            title: `Change ${index + 1}`,
            url: `https://gitlab.com/acme/web/-/merge_requests/${index + 1}`,
            state,
            isDraft: index === 4,
          }),
        ),
      ]);

      const missing = yield* Effect.flip(api.getIssue({ ...target, key: "123" }));
      expect(missing.reason).toBe("not-found");
    }),
  );

  it.effect.each(["ENG", "acme/ENG"])("uses native team and member IDs with scope %s", (scope) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: {
                  nodes: [
                    user("usr_imposter", "usr_display"),
                    user("usr_display", "  Display Name  "),
                    { ...user("usr_name", "  Full Name  "), displayName: "  " },
                    { ...user("usr_id", "  "), displayName: null },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                ancestors: [],
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-7",
            url: "https://linear.app/acme/issue/ENG-7",
            team: { key: "ENG" },
          },
        }),
        T3IssueUpdate: (variables) => {
          expect(variables).toEqual({ id: "iss_native", input: { assigneeId: "usr_display" } });
          return { issueUpdate: { success: true } };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ teamId: "team_eng", assigneeId: "usr_display" });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope };
      const candidates = yield* api.listCandidates(scoped);
      expect(candidates.assignees.map(({ id, login }) => ({ id, login }))).toEqual([
        { id: "usr_imposter", login: "usr_display" },
        { id: "usr_display", login: "Display Name" },
        { id: "usr_name", login: "Full Name" },
        { id: "usr_id", login: "usr_id" },
      ]);
      yield* api.update({ ...scoped, key: "ENG-7", assignees: ["usr_display"] });
      yield* api.create({
        ...scoped,
        title: "New",
        body: "",
        labels: [],
        assignees: ["usr_display"],
      });
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3Team",
        "T3IssueReference",
        "T3Team",
        "T3IssueUpdate",
        "T3Team",
        "T3IssueCreate",
      ]);
    }),
  );
  it.effect("requires a native label ID when team and workspace names collide", () =>
    Effect.gen(function* () {
      const label = labelFixture({ id: "team_bug", name: "Bug", color: "#000" });
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [label], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
          },
          issueLabels: {
            nodes: [{ ...label, id: "workspace_bug" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ labelIds: ["workspace_bug"] });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const input = { ...target, scope: "acme/ENG", title: "New", body: "", assignees: [] };
      const error = yield* api.create({ ...input, labels: ["Bug"] }).pipe(Effect.flip);
      expect(error.detail).toContain("ambiguous");
      expect(test.requests.map((request) => request.operation)).toEqual(["T3Team"]);
      yield* api.create({ ...input, labels: ["workspace_bug"] });
    }),
  );

  it.effect("retains archived labels and child labels while refusing native label groups", () =>
    Effect.gen(function* () {
      const old = labelFixture({
        id: "lbl_old",
        name: "Old",
        color: "#000",
        archivedAt: "2026-01-01T00:00:00Z",
      });
      const group = labelFixture({
        id: "lbl_type",
        name: "Type",
        color: "#000",
        archivedAt: null,
        isGroup: true,
      });
      const bug = labelFixture({
        id: "lbl_bug",
        name: "Bug",
        color: "#000",
        archivedAt: null,
        isGroup: false,
        parent: group,
      });
      const workspaceOld = { ...old, id: "lbl_workspace_old", name: "WorkspaceOld" };
      const workspaceGroup = { ...group, id: "lbl_workspace_type", name: "WorkspaceType" };
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: {
                  nodes: test.requests
                    .at(-1)
                    ?.query.includes(
                      stripIgnoredCharacters("labels(first: 250, includeArchived: true)"),
                    )
                    ? [old, group, bug]
                    : [group, bug],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
          },
          issueLabels: {
            nodes: test.requests
              .at(-1)
              ?.query.includes(
                stripIgnoredCharacters("issueLabels(first: 250, includeArchived: true"),
              )
              ? [workspaceOld, workspaceGroup]
              : [workspaceGroup],
            pageInfo: { hasNextPage: true, endCursor: "more-labels" },
          },
        }),
        T3IssueUpdate: (variables) => {
          expect(variables.input).toEqual({ labelIds: [old.id, bug.id, workspaceOld.id] });
          return { issueUpdate: { success: true } };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ labelIds: [bug.id] });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG" };
      yield* api.update({ ...scoped, key: "ENG-7", labels: [old.id, bug.id, workspaceOld.id] });
      const candidates = yield* api.listCandidates(scoped);
      expect(candidates.labels).toEqual([
        { id: bug.id, name: "Bug", color: "#000", description: null },
      ]);
      expect(candidates.truncated).toBe(true);
      expect(test.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3Team",
        "T3IssueUpdate",
        "T3Team",
      ]);
      yield* api.create({ ...scoped, title: "New", body: "", labels: [bug.id], assignees: [] });
      for (const label of [group, workspaceGroup]) {
        test.requests.length = 0;
        expect(
          (yield* api
            .create({ ...scoped, title: "New", body: "", labels: [label.name], assignees: [] })
            .pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual(["T3Team"]);
        test.requests.length = 0;
        expect(
          (yield* api.update({ ...scoped, key: "ENG-7", labels: [label.name] }).pipe(Effect.flip))
            .reason,
        ).toBe("failed");
        expect(test.requests.map((request) => request.operation)).toEqual([
          "T3IssueReference",
          "T3Team",
        ]);
      }
    }),
  );
  it.effect.each([false, true])(
    "requires a unique assignee fallback on a complete member page: partial=%s",
    (partial) =>
      Effect.gen(function* () {
        const written: unknown[] = [];
        const test = fakeLinear({
          T3IssueReference: () => ({ issue: issue("ENG-7") }),
          T3Team: () => ({
            organization: ORGANIZATION,
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  private: true,
                  visibility: "private",
                  restrictedBy: null,
                  states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  members: {
                    nodes: [
                      { ...user("usr_first", "Sam"), email: "first@acme.test" },
                      { ...user("usr_second", "Sam"), email: "second@acme.test" },
                      user("usr_solo", "Solo"),
                    ],
                    pageInfo: { hasNextPage: partial, endCursor: partial ? "more-members" : null },
                  },
                  ancestors: [],
                  templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              ],
            },
            issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
          T3IssueUpdate: (variables) => {
            written.push(variables.input);
            return { issueUpdate: { success: true } };
          },
          T3IssueCreate: (variables) => {
            written.push(variables.input);
            return {
              issueCreate: {
                success: true,
                issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
              },
            };
          },
        });
        const api = yield* test.tracker;
        const scoped = { ...target, scope: "acme/ENG" };
        for (const [input, expected] of [
          ["usr_second", "usr_second"],
          ["SECOND@ACME.TEST", partial ? null : "usr_second"],
          ["solo", partial ? null : "usr_solo"],
          ["Sam", null],
        ] as const) {
          for (const [action, calls] of [
            [
              api.create({ ...scoped, title: "New", body: "", labels: [], assignees: [input] }),
              ["T3Team", "T3IssueCreate"],
            ],
            [
              api.update({ ...scoped, key: "ENG-7", assignees: [input] }),
              ["T3IssueReference", "T3Team", "T3IssueUpdate"],
            ],
          ] as const) {
            test.requests.length = 0;
            if (expected === null) {
              const before = written.length;
              expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
              expect(written).toHaveLength(before);
              expect(test.requests.map((request) => request.operation)).toEqual(calls.slice(0, -1));
            } else {
              yield* action;
              expect(written.at(-1)).toMatchObject({ assigneeId: expected });
              expect(test.requests.map((request) => request.operation)).toEqual(calls);
            }
          }
        }
      }),
  );
  it.effect("closes through the team's completed state and reports a missing key", () =>
    Effect.gen(function* () {
      const updates: Array<Record<string, unknown>> = [];
      const { tracker } = fakeLinear(
        {
          T3TeamStates: () => ({
            organization: ORGANIZATION,
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
                  members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  ancestors: [],
                  templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              ],
            },
            issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          }),
          T3IssueUpdate: (variables) => {
            updates.push(variables);
            return { issueUpdate: { success: true } };
          },
        },
        null,
      );
      const api = yield* tracker;
      const unauthenticated = yield* Effect.flip(
        api.setState({ ...target, key: "ENG-1", state: "closed" }),
      );
      expect(unauthenticated.reason).toBe("unauthenticated");

      const connected = fakeLinear({
        T3IssueReference: () => ({
          issue: {
            id: "iss_native",
            identifier: "ENG-1",
            url: "https://linear.app/acme/issue/ENG-1",
            team: { key: "ENG" },
          },
        }),
        T3TeamStates: () => ({
          organization: ORGANIZATION,
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
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            ],
          },
          issueLabels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }),
        T3IssueUpdate: (variables) => {
          updates.push(variables);
          return { issueUpdate: { success: true } };
        },
      });
      const live = yield* connected.tracker;
      yield* live.setState({ ...target, key: "ENG-1", state: "closed", closeReason: "canceled" });
      yield* live.setState({ ...target, key: "ENG-1", state: "closed" });
      yield* live.setState({ ...target, key: "ENG-1", state: "open" });
      expect(updates.map((update) => update.input)).toEqual([
        { stateId: "st_canceled" },
        { stateId: "st_done" },
        { stateId: "st_todo" },
      ]);
      expect(connected.requests.map((request) => request.operation)).toEqual([
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
        "T3IssueReference",
        "T3TeamStates",
        "T3IssueUpdate",
      ]);
      expect(connected.requests[1]?.query).not.toMatch(/labels|members|templates|issueLabels/u);
      expect(updates.map((update) => update.id)).toEqual([
        "iss_native",
        "iss_native",
        "iss_native",
      ]);
    }),
  );

  it("offers plain templates as drafts and form or rich ones as links into Linear", () => {
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
    );
    expect(plain).toEqual({
      template: {
        key: "tpl_1",
        name: "Bug report",
        about: "For bugs",
        title: "Bug: ",
        body: "## Steps",
        labels: ["lbl_bug", "lbl_unknown"],
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
    );
    expect(form).toEqual({
      link: { name: "Intake", about: "", url: "https://linear.app/team/ENG/new?template=tpl_2" },
    });
    for (const templateData of [
      { description: { type: "doc" } },
      { descriptionData: { type: "doc" } },
    ]) {
      expect(
        LinearIssueTracker.toTemplate(
          {
            id: "tpl_rich",
            name: "Rich",
            description: null,
            content: null,
            type: "issue",
            hasFormFields: false,
            templateData,
          },
          "ENG",
        ),
      ).toEqual({
        link: { name: "Rich", about: "", url: "https://linear.app/team/ENG/new?template=tpl_rich" },
      });
    }
  });
});

it.effect.each(["acme/ENG", ""])("validates scope before an empty category filter: %s", (scope) =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3Issues: () => ({
        organization: ORGANIZATION,
        issues: {
          nodes: [issue("ENG-7")],
          pageInfo: { hasNextPage: true, endCursor: "next-native" },
        },
      }),
    });
    const api = yield* test.tracker;
    const request = api.listIssues({
      ...target,
      scope,
      state: "closed",
      involvement: "all",
      viewer: JULIUS.id,
      limit: 20,
      cursor: "previous-native",
      stateCategories: [],
    });
    if (scope === "") expect((yield* request.pipe(Effect.flip)).reason).toBe("failed");
    else expect(yield* request).toEqual({ items: [], nextCursor: null });
    expect(test.requests).toHaveLength(0);
  }),
);

it.effect("keeps all states and the native cursor when category filtering is omitted", () =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3Issues: () => ({
        organization: ORGANIZATION,
        issues: {
          nodes: [issue("ENG-7"), issue("ENG-8", { state: state("Done", "completed") })],
          pageInfo: { hasNextPage: true, endCursor: "next-native" },
        },
      }),
    });
    const api = yield* test.tracker;
    const page = yield* api.listIssues({
      ...target,
      state: "all",
      involvement: "all",
      viewer: JULIUS.id,
      limit: 20,
      cursor: "previous-native",
    });
    expect(page.items.map(({ key }) => key)).toEqual(["ENG-7", "ENG-8"]);
    expect(page.nextCursor).toBe("next-native");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
    expect(test.requests[0]?.variables).toMatchObject({
      first: 20,
      after: "previous-native",
      filter: { team: { key: { eq: "ENG" } } },
    });
    expect(test.requests[0]?.variables.filter).not.toHaveProperty("state");
  }),
);

it.effect.each(["asc", "desc"] as const)(
  "rejects unchanged Linear issue cursors in %s order without extra requests",
  (order) =>
    Effect.gen(function* () {
      for (const nextCursor of ["same", "next", null]) {
        const test = fakeLinear({
          T3Issues: () => ({
            organization: ORGANIZATION,
            issues: {
              nodes: [issue("ENG-7")],
              pageInfo: {
                hasNextPage: nextCursor !== null,
                endCursor: nextCursor ?? "same",
                hasPreviousPage: nextCursor !== null,
                startCursor: nextCursor ?? "same",
              },
            },
          }),
        });
        const api = yield* test.tracker;
        const result = api.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          viewer: JULIUS.id,
          limit: 1,
          cursor: "same",
          order,
        });
        if (nextCursor === "same")
          expect(yield* result.pipe(Effect.flip)).toMatchObject({
            reason: "failed",
            operation: "listIssues",
            detail: "Linear returned an inconsistent page.",
          });
        else expect(yield* result).toMatchObject({ items: [{ key: "ENG-7" }], nextCursor });
        expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Issues"]);
        expect(test.requests[0]?.variables).toMatchObject(
          order === "asc" ? { before: "same", after: null } : { before: null, after: "same" },
        );
      }
    }),
);

it.effect("pages native workflow filters and ascending order without a viewer read", () =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3Issues: () => ({
        organization: ORGANIZATION,
        issues: {
          nodes: [issue("ENG-2"), issue("ENG-1", { state: state("Triage", "triage") })],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
            hasPreviousPage: true,
            startCursor: "earlier",
          },
        },
      }),
    });
    const api = yield* test.tracker;
    const page = yield* api.listIssues({
      ...target,
      state: "open",
      involvement: "all",
      viewer: JULIUS.id,
      limit: 2,
      stateCategories: ["backlog", "canceled"],
      sort: "created",
      order: "asc",
      cursor: "before",
    });
    expect(page.items[0]?.state).toMatchObject({
      id: "st_triage",
      workflowCategory: "backlog",
      category: "open",
      name: "Triage",
    });
    expect(page.nextCursor).toBe("earlier");
    expect(page.items.map((item) => item.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]?.variables).toMatchObject({
      first: null,
      last: 2,
      before: "before",
      after: null,
      orderBy: "createdAt",
      filter: { state: { type: { in: ["backlog", "triage", "canceled", "duplicate"] } } },
    });
    expect(
      (yield* api
        .listIssues({
          ...target,
          state: "all",
          involvement: "all",
          viewer: JULIUS.id,
          limit: 10,
          sort: "comments",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("failed");
  }),
);

it.effect("checks the comment target and lets native token rights decide edits", () =>
  Effect.gen(function* () {
    let allowed = true;
    let commentIssue = "ENG-7";
    let applied = 0;
    const test = fakeLinear({
      T3CommentTarget: () => ({
        issue: issue("ENG-7"),
        comment: { id: "comment-1", issue: issue(commentIssue) },
      }),
      T3CommentUpdate: () => {
        if (!allowed)
          return Response.json(
            { errors: [{ message: "The token cannot edit this comment." }] },
            { status: 400 },
          );
        applied++;
        return { commentUpdate: { success: true } };
      },
    });
    const api = yield* test.tracker;
    yield* api.editComment({ ...target, key: "ENG-7", commentId: "comment-1", body: "new" });
    expect(test.requests.map((request) => request.operation)).toEqual([
      "T3CommentTarget",
      "T3CommentUpdate",
    ]);
    expect(test.requests[1]?.variables).toEqual({ id: "comment-1", input: { body: "new" } });
    allowed = false;
    expect(
      (yield* api
        .editComment({
          ...target,
          key: "ENG-7",
          viewer: "spoofed",
          commentId: "comment-1",
          body: "forbidden",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("failed");
    allowed = true;
    commentIssue = "ENG-8";
    yield* api
      .editComment({ ...target, key: "ENG-7", commentId: "comment-1", body: "wrong issue" })
      .pipe(Effect.flip);
    expect(test.requests.filter((request) => request.operation === "T3CommentUpdate")).toHaveLength(
      2,
    );
    expect(applied).toBe(1);
  }),
);

it.effect("pages hierarchy, history and attachments while checking the source scope", () =>
  Effect.gen(function* () {
    const next = { hasNextPage: true, endCursor: "next" };
    const relation = issue("ENG-8");
    const history = {
      id: "history-1",
      createdAt: "2026-07-02T00:00:00.000Z",
      actor: JULIUS,
      fromState: state("Todo", "unstarted"),
      toState: state("Done", "completed"),
      fromAssignee: null,
      toAssignee: null,
      addedLabels: null,
      removedLabels: null,
      fromTitle: null,
      toTitle: null,
    };
    let source = "ENG-7";
    const test = fakeLinear({
      T3Hierarchy: () => ({
        issue: { ...issue(source), parent: null, children: { nodes: [relation], pageInfo: next } },
      }),
      T3History: () => ({
        issue: { ...issue(source), history: { nodes: [history], pageInfo: next } },
      }),
      T3Attachments: () => ({
        issue: {
          ...issue(source),
          attachments: {
            nodes: [
              {
                url: "https://github.com/acme/repo/pull/7",
                title: "Fix",
                sourceType: "github",
                metadata: { status: "merged" },
              },
            ],
            pageInfo: next,
          },
        },
      }),
    });
    const api = yield* test.tracker;
    const input = { ...target, key: "ENG-7", limit: 1 };
    expect((yield* api.getHierarchy(input)).children).toMatchObject({
      items: [{ key: "ENG-8", scope: "ENG" }],
      nextCursor: "next",
    });
    const historyPage = yield* api.getHistory(input);
    expect(historyPage.items).toMatchObject([{ kind: "closed" }]);
    expect(JSON.parse(historyPage.nextCursor!)[1]).toBe("next");
    expect(yield* api.getLinkedPullRequests(input)).toMatchObject({
      items: [{ number: 7, state: "merged" }],
      nextCursor: "next",
    });
    expect(test.requests).toHaveLength(3);
    source = "OPS-7";
    expect((yield* api.getHierarchy(input).pipe(Effect.flip)).reason).toBe("failed");
    source = "ENG-7";
    expect((yield* api.getHistory({ ...input, cursor: "next" }).pipe(Effect.flip)).reason).toBe(
      "failed",
    );
  }),
);

it.effect("sets and clears parent links while rejecting self and foreign parents", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const test = fakeLinear({
      T3IssueReference: (variables) => ({ issue: issue(String(variables.id)) }),
      T3IssueUpdate: (variables) => {
        writes.push(variables);
        return { issueUpdate: { success: true } };
      },
    });
    const api = yield* test.tracker;
    yield* api.setParent({ ...target, key: "ENG-7", parentKey: "ENG-8" });
    yield* api.setParent({ ...target, key: "ENG-7", parentKey: null });
    yield* api.setParent({ ...target, key: "ENG-7", parentKey: "ENG-7" }).pipe(Effect.flip);
    yield* api.setParent({ ...target, key: "ENG-7", parentKey: "OPS-8" });
    expect(writes).toEqual([
      { id: "iss_ENG-7", input: { parentId: "iss_ENG-8" } },
      { id: "iss_ENG-7", input: { parentId: null } },
      { id: "iss_ENG-7", input: { parentId: "iss_OPS-8" } },
    ]);
  }),
);

it.effect("pages label and member candidates with native cursors and workspace checks", () =>
  Effect.gen(function* () {
    const pageInfo = { hasNextPage: true, endCursor: "more" };
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const test = fakeLinear({
      T3Team: () => ({
        organization: ORGANIZATION,
        issueLabels: empty,
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
              private: true,
              visibility: "private",
              restrictedBy: null,
              ancestors: [],
              states: empty,
              labels: empty,
              members: empty,
              templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          ],
        },
      }),
      T3LabelCandidates: () => ({
        organization: ORGANIZATION,
        teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] },
        issueLabels: {
          nodes: [labelFixture({ id: "label-1", name: "Bug", color: "#f00", description: null })],
          pageInfo,
        },
      }),
      T3AssigneeCandidates: () => ({
        organization: ORGANIZATION,
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
              private: true,
              visibility: "private",
              restrictedBy: null,
              ancestors: [],
              members: { nodes: [JULIUS], pageInfo },
            },
          ],
        },
      }),
    });
    const api = yield* test.tracker;
    expect(yield* api.listLabelCandidates({ ...target, limit: 1 })).toMatchObject({
      items: [{ name: "Bug" }],
      nextCursor: "more",
    });
    expect(yield* api.listAssigneeCandidates({ ...target, limit: 1 })).toMatchObject({
      items: [{ id: JULIUS.id }],
      nextCursor: "more",
    });
    yield* api.listLabelCandidates({ ...target, scope: "foreign/ENG", limit: 1 }).pipe(Effect.flip);
    expect(test.requests).toHaveLength(5);
  }),
);

it.effect("sets native workflow state IDs and names but refuses an unknown state", () =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3IssueReference: () => ({ issue: issue("ENG-7") }),
      T3TeamStates: () => ({
        organization: ORGANIZATION,
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
              states: {
                nodes: [state("Review", "started"), state("Todo", "unstarted")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
        },
      }),
      T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
    });
    const api = yield* test.tracker;
    yield* api.setState({ ...target, key: "ENG-7", state: "st_review" });
    yield* api.setState({ ...target, key: "ENG-7", state: "Review" });
    expect(
      (yield* api.setState({ ...target, key: "ENG-7", state: "missing" }).pipe(Effect.flip)).reason,
    ).toBe("failed");
    expect(
      test.requests
        .filter((request) => request.operation === "T3IssueUpdate")
        .map((request) => request.variables.input),
    ).toEqual([{ stateId: "st_review" }, { stateId: "st_review" }]);
  }),
);

it.effect("creates an issue with a checked parent and a plain native template", () =>
  Effect.gen(function* () {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const test = fakeLinear({
      T3Team: () => ({
        organization: ORGANIZATION,
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
              private: true,
              visibility: "private",
              restrictedBy: null,
              states: empty,
              labels: empty,
              members: empty,
              ancestors: [],
              templates: {
                pageInfo: empty.pageInfo,
                nodes: [
                  {
                    id: "template-1",
                    name: "Bug",
                    description: "Report a bug",
                    content: "Steps",
                    type: "issue",
                    hasFormFields: false,
                    templateData: {},
                  },
                ],
              },
            },
          ],
        },
        issueLabels: empty,
      }),
      T3IssueReference: () => ({ issue: issue("ENG-7") }),
      T3IssueCreate: () => ({
        issueCreate: {
          success: true,
          issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
        },
      }),
    });
    const api = yield* test.tracker;
    const input = {
      ...target,
      title: "Child",
      body: "Steps",
      labels: [],
      assignees: [],
      parentKey: "ENG-7",
      templateKey: "template-1",
    };
    expect(yield* api.create(input)).toMatchObject({ key: "ENG-8", parentLinked: true });
    expect(
      test.requests.find((request) => request.operation === "T3IssueCreate")?.variables.input,
    ).toMatchObject({ teamId: "team-1", parentId: "iss_ENG-7", templateId: "template-1" });
    yield* api.create({ ...input, templateKey: "missing" }).pipe(Effect.flip);
    expect(test.requests.filter((request) => request.operation === "T3IssueCreate")).toHaveLength(
      1,
    );
  }),
);

it.effect("rejects unchanged Linear comment cursors without extra requests", () =>
  Effect.gen(function* () {
    for (const nextCursor of ["same", "next", null]) {
      const test = fakeLinear({
        T3Comments: () => ({
          issue: {
            ...issue("ENG-7"),
            comments: {
              nodes: [
                {
                  id: "comment-1",
                  body: "Saved comment",
                  createdAt: "2026-07-01T00:00:00Z",
                  url: "https://linear.app/acme/issue/ENG-7#comment",
                  editedAt: null,
                  user: JULIUS,
                  reactions: [],
                },
              ],
              pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor ?? "same" },
            },
          },
        }),
      });
      const api = yield* test.tracker;
      const cursor = JSON.stringify([
        JSON.stringify([
          "linear-activity-v1",
          "getComments",
          target.cwd,
          target.host,
          "eng",
          "ENG-7",
          null,
          "desc",
          50,
        ]),
        "same",
      ]);
      const result = api.getComments({ ...target, key: "ENG-7", cursor });
      if (nextCursor === "same")
        expect(yield* result.pipe(Effect.flip)).toMatchObject({
          reason: "failed",
          operation: "getComments",
          detail: "Linear returned an inconsistent page.",
        });
      else {
        const page = yield* result;
        expect(page.comments).toMatchObject([{ id: "comment-1" }]);
        expect(page.nextCursor === null ? null : JSON.parse(page.nextCursor)[1]).toBe(nextCursor);
      }
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Comments"]);
      expect(test.requests[0]?.variables.after).toBe("same");
    }
  }),
);

it.effect("maps editable old comments with the supplied viewer and native edit time", () =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3Comments: () => ({
        issue: {
          ...issue("ENG-7"),
          comments: {
            nodes: [
              {
                id: "c1",
                body: "edited",
                createdAt: "2026-07-01T00:00:00.000Z",
                editedAt: "2026-07-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/ENG-7#comment",
                user: JULIUS,
                reactions: [],
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });
    const api = yield* test.tracker;
    const result = yield* api.getComments({
      ...target,
      key: "ENG-7",
      cursor: JSON.stringify([
        JSON.stringify([
          "linear-activity-v1",
          "getComments",
          target.cwd,
          target.host,
          "eng",
          "ENG-7",
          null,
          "desc",
          50,
        ]),
        "older",
      ]),
      viewer: JULIUS.id,
    });
    expect(result.comments[0]).toMatchObject({
      canEdit: true,
      editedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(test.requests.map((request) => request.operation)).toEqual(["T3Comments"]);
  }),
);

it.effect.each([{}, { unrelated: { success: true } }, { commentUpdate: { success: false } }])(
  "requires the named native comment edit result: %j",
  (response) =>
    Effect.gen(function* () {
      const test = fakeLinear({ T3CommentUpdate: () => response });
      const api = yield* test.api;
      expect((yield* api.updateComment("comment-1", "Changed").pipe(Effect.flip)).reason).toBe(
        "failed",
      );
      expect(test.requests).toHaveLength(1);
    }),
);

it.effect("retains history entries with no known field change", () =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3History: () => ({
        issue: {
          ...issue("ENG-7"),
          history: {
            nodes: [
              {
                id: "history-native",
                createdAt: "2026-07-01T00:00:00Z",
                actor: null,
                fromState: null,
                toState: null,
                fromAssignee: null,
                toAssignee: null,
                addedLabels: [],
                removedLabels: [],
                fromTitle: null,
                toTitle: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });
    const api = yield* test.tracker;
    expect(yield* api.getHistory({ ...target, key: "ENG-7" })).toMatchObject({
      items: [{ id: "history-native:updated", kind: "updated", detail: "Issue updated" }],
      nextCursor: null,
    });
  }),
);

it.effect.each(["create", "update"] as const)(
  "uses scoped native IDs beyond the initial 250 without scans: %s",
  (operation) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const labels = Array.from({ length: 250 }, (_, n) => ({
        id: `label-${n}`,
        name: "Same",
        color: "#000",
        description: null,
        archivedAt: null,
        isGroup: false,
      }));
      const members = Array.from({ length: 250 }, (_, n) => user(`member-${n}`, "Same"));
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: true,
        visibility: "private",
        restrictedBy: null,
        states: empty,
        labels: { nodes: labels, pageInfo: { hasNextPage: true, endCursor: "labels-250" } },
        members: { nodes: members, pageInfo: { hasNextPage: true, endCursor: "members-250" } },
        ancestors: [],
        templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      };
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: { nodes: [team] },
          issueLabels: empty,
        }),
        T3LabelCandidates: (variables) => {
          expect(variables).toMatchObject({
            first: 1,
            after: null,
            filter: {
              and: [
                { or: [{ team: { id: { in: ["team_eng"] } } }, { team: { null: true } }] },
                { id: { in: ["label-250"] } },
              ],
            },
          });
          return {
            organization: ORGANIZATION,
            teams: { nodes: [team] },
            issueLabels: {
              nodes: [labelFixture({ id: "label-250", name: "Same", color: "#000" })],
              pageInfo: empty.pageInfo,
            },
          };
        },
        T3AssigneeCandidates: (variables) => {
          expect(variables).toMatchObject({
            first: 1,
            after: null,
            filter: {
              active: { eq: true },
              id: { eq: "member-250" },
            },
          });
          return {
            organization: ORGANIZATION,
            teams: {
              nodes: [
                {
                  ...team,
                  members: {
                    nodes: [user("member-250", "Same")],
                    pageInfo: empty.pageInfo,
                  },
                },
              ],
            },
          };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({
            labelIds: ["label-250"],
            assigneeId: "member-250",
          });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
        T3IssueUpdate: (variables) => {
          expect(variables.input).toEqual({ labelIds: ["label-250"], assigneeId: "member-250" });
          return { issueUpdate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      const selection = {
        ...target,
        scope: "acme/ENG",
        labels: ["label-250"],
        assignees: ["member-250"],
      };
      if (operation === "create") yield* api.create({ ...selection, title: "New", body: "" });
      else yield* api.update({ ...selection, key: "ENG-7" });
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        ...(operation === "update" ? ["T3IssueReference"] : []),
        "T3Team",
        "T3LabelCandidates",
        "T3AssigneeCandidates",
        operation === "create" ? "T3IssueCreate" : "T3IssueUpdate",
      ]);
    }),
);

it.effect.each([
  "foreign",
  "partial",
  "missing",
  "group",
  "wrong-id",
  "duplicate",
  "too-many",
] as const)("refuses invalid selected label IDs without a mutation: %s", (failure) =>
  Effect.gen(function* () {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const team = {
      id: "team_eng",
      key: "ENG",
      name: "Engineering",
      private: true,
      visibility: "private",
      restrictedBy: null,
      states: empty,
      labels: { ...empty, pageInfo: { hasNextPage: true, endCursor: "more" } },
      members: empty,
      ancestors: [],
      templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const test = fakeLinear({
      T3IssueReference: () => ({ issue: issue("ENG-7") }),
      T3Team: () => ({
        organization: ORGANIZATION,
        teams: { nodes: [team] },
        issueLabels: empty,
      }),
      T3LabelCandidates: () => ({
        organization: failure === "foreign" ? { ...ORGANIZATION, id: "org_other" } : ORGANIZATION,
        teams: { nodes: [team] },
        issueLabels: {
          nodes:
            failure === "missing"
              ? []
              : [
                  labelFixture({
                    id: failure === "wrong-id" ? "other" : "chosen",
                    name: "Same",
                    color: "#000",
                    isGroup: failure === "group",
                  }),
                  ...(failure === "duplicate"
                    ? [labelFixture({ id: "chosen", name: "Same", color: "#000" })]
                    : []),
                ],
          pageInfo: {
            hasNextPage: failure === "partial",
            endCursor: failure === "partial" ? "more" : null,
          },
        },
      }),
    });
    const api = yield* test.tracker;
    const labels =
      failure === "too-many" ? Array.from({ length: 201 }, (_, n) => `label-${n}`) : ["chosen"];
    for (const action of [
      api.create({ ...target, title: "New", body: "", labels, assignees: [] }),
      api.update({ ...target, key: "ENG-7", labels }),
    ]) {
      test.requests.length = 0;
      expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
      expect(
        test.requests.some(
          ({ operation }) => operation.includes("Create") || operation.includes("Update"),
        ),
      ).toBe(false);
      expect(test.requests).toHaveLength(
        failure === "too-many"
          ? test.requests[0]?.operation === "T3IssueReference"
            ? 2
            : 1
          : test.requests[0]?.operation === "T3IssueReference"
            ? 3
            : 2,
      );
    }
  }),
);

it.effect.each(["foreign", "partial", "inactive", "wrong-id"] as const)(
  "refuses invalid selected member IDs without a mutation: %s",
  (failure) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: true,
        visibility: "private",
        restrictedBy: null,
        states: empty,
        labels: empty,
        members: { ...empty, pageInfo: { hasNextPage: true, endCursor: "more" } },
        ancestors: [],
        templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      };
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: { nodes: [team] },
          issueLabels: empty,
        }),
        T3AssigneeCandidates: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                ...team,
                id: failure === "foreign" ? "other-team" : team.id,
                members: {
                  nodes:
                    failure === "inactive"
                      ? []
                      : [user(failure === "wrong-id" ? "other" : "chosen", "Same")],
                  pageInfo: {
                    hasNextPage: failure === "partial",
                    endCursor: failure === "partial" ? "more" : null,
                  },
                },
              },
            ],
          },
        }),
      });
      const api = yield* test.tracker;
      for (const action of [
        api.create({ ...target, title: "New", body: "", labels: [], assignees: ["chosen"] }),
        api.update({ ...target, key: "ENG-7", assignees: ["chosen"] }),
      ]) {
        test.requests.length = 0;
        expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
        expect(
          test.requests.some(
            ({ operation }) => operation.includes("Create") || operation.includes("Update"),
          ),
        ).toBe(false);
      }
    }),
);

it.effect.each(["comment", "update", "state", "parent", "clearParent"] as const)(
  "does not duplicate Linear issue reads after static permission lookup: %s",
  (operation) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: (variables) => ({ issue: issue(String(variables.id)) }),
        T3TeamStates: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: {
                  nodes: [state("Done", "completed")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
          },
        }),
        T3CommentCreate: () => ({ commentCreate: { success: true } }),
        T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
      });
      const api = yield* test.tracker;
      const input = { ...target, scope: "acme/ENG", key: "ENG-7" };
      expect(yield* api.getViewerPermissions(input)).toMatchObject({
        comment: true,
        edit: true,
        setState: true,
      });
      expect(test.requests).toHaveLength(0);
      const actions = {
        comment: api.comment({ ...input, body: "Comment" }),
        update: api.update({ ...input, title: "Changed" }),
        state: api.setState({ ...input, state: "closed" }),
        parent: api.setParent({ ...input, parentKey: "ENG-8" }),
        clearParent: api.setParent({ ...input, parentKey: null }),
      };
      yield* actions[operation];
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        "T3IssueReference",
        ...(operation === "state"
          ? ["T3TeamStates"]
          : operation === "parent"
            ? ["T3IssueReference"]
            : []),
        operation === "comment" ? "T3CommentCreate" : "T3IssueUpdate",
      ]);
    }),
);

it.effect.each(["team", "workspace"] as const)(
  "static Linear permissions never bypass native write scope guards: %s",
  (foreign) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        T3IssueReference: () => ({
          issue:
            foreign === "team"
              ? issue("OPS-7")
              : issue("ENG-7", { url: "https://linear.app/other/issue/ENG-7" }),
        }),
      });
      const api = yield* test.tracker;
      const input = { ...target, scope: "acme/ENG", key: "ENG-7" };
      yield* api.getViewerPermissions(input);
      expect(test.requests).toHaveLength(0);
      for (const action of [
        api.comment({ ...input, body: "Comment" }),
        api.update({ ...input, title: "Changed" }),
        api.setState({ ...input, state: "closed" }),
        api.setParent({ ...input, parentKey: "ENG-8" }),
        api.setParent({ ...input, parentKey: null }),
      ]) {
        test.requests.length = 0;
        expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
        expect(test.requests.map(({ operation }) => operation)).toEqual(["T3IssueReference"]);
      }
    }),
);
it.effect.each([false, true])(
  "lists and retains native parent-team labels: partial=%s",
  (partial) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const parentLabel = labelFixture({ id: "parent-security", name: "Security", color: "#000" });
      const childLabel = { ...parentLabel, id: "child-security" };
      const other = labelFixture({ id: "other", name: "Other", color: "#000" });
      const written: unknown[] = [];
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: true,
        visibility: "private",
        restrictedBy: null,
        states: empty,
        members: empty,
        labels: { ...empty, nodes: [childLabel, other] },
        templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        ancestors: [
          {
            id: "team_parent",
            key: "PARENT",
            name: "Parent",
            private: false,
            visibility: "public",
            restrictedBy: null,
            templates: empty,
            labels: {
              nodes: [parentLabel],
              pageInfo: { hasNextPage: partial, endCursor: "parent-more" },
            },
          },
        ],
      };
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: { nodes: [team] },
          issueLabels: empty,
        }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3LabelCandidates: (variables) => {
          expect(variables.filter).toMatchObject({
            and: [
              {
                or: [
                  { team: { id: { in: ["team_eng", "team_parent"] } } },
                  { team: { null: true } },
                ],
              },
              ...(variables.after === "previous"
                ? []
                : [
                    {
                      id: {
                        in: [
                          JSON.stringify(variables.filter).includes("parent-hidden")
                            ? "parent-hidden"
                            : "foreign",
                        ],
                      },
                    },
                  ]),
            ],
          });
          return {
            organization: ORGANIZATION,
            teams: { nodes: [team] },
            issueLabels:
              variables.after === "previous"
                ? {
                    nodes: [parentLabel],
                    pageInfo: { hasNextPage: true, endCursor: "next-native" },
                  }
                : {
                    ...empty,
                    nodes:
                      variables.filter &&
                      JSON.stringify(variables.filter).includes('"parent-hidden"')
                        ? [{ ...parentLabel, id: "parent-hidden" }]
                        : [],
                  },
          };
        },
        T3IssueUpdate: (variables) => {
          written.push(variables.input);
          return { issueUpdate: { success: true } };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ labelIds: [parentLabel.id] });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const candidates = yield* api.listCandidates(target);
      expect(test.requests.at(-1)?.variables.includeAncestorLabels).toBe(true);
      expect(candidates.labels.map(({ id }) => id)).toEqual([
        childLabel.id,
        other.id,
        parentLabel.id,
      ]);
      expect(candidates.truncated).toBe(partial);
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
      test.requests.length = 0;
      expect(
        yield* api.listLabelCandidates({ ...target, limit: 1, cursor: "previous" }),
      ).toMatchObject({
        items: [{ id: parentLabel.id }],
        nextCursor: "next-native",
      });
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3Team",
        "T3LabelCandidates",
      ]);
      expect(test.requests[0]?.variables.includeAncestorLabels).toBe(false);
      test.requests.length = 0;
      yield* api.update({ ...target, key: "ENG-7", labels: [parentLabel.id, other.id] });
      expect(test.requests[1]?.variables.includeAncestorLabels).toBe(true);
      expect(written.at(-1)).toEqual({ labelIds: [parentLabel.id, other.id] });
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3IssueReference",
        "T3Team",
        "T3IssueUpdate",
      ]);
      test.requests.length = 0;
      yield* api.create({
        ...target,
        title: "New",
        body: "",
        labels: [parentLabel.id],
        assignees: [],
      });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team", "T3IssueCreate"]);
      expect(test.requests[0]?.variables.includeAncestorLabels).toBe(true);
      expect(
        (yield* api.update({ ...target, key: "ENG-7", labels: ["Security"] }).pipe(Effect.flip))
          .detail,
      ).toContain("ambiguous");
      if (partial) {
        expect(
          (yield* api.update({ ...target, key: "ENG-7", labels: [other.name] }).pipe(Effect.flip))
            .detail,
        ).toContain("incomplete");
        test.requests.length = 0;
        yield* api.update({ ...target, key: "ENG-7", labels: ["parent-hidden"] });
        expect(written.at(-1)).toEqual({ labelIds: ["parent-hidden"] });
        expect(test.requests.map(({ operation }) => operation)).toEqual([
          "T3IssueReference",
          "T3Team",
          "T3LabelCandidates",
          "T3IssueUpdate",
        ]);
        const before = written.length;
        test.requests.length = 0;
        yield* api.update({ ...target, key: "ENG-7", labels: ["foreign"] }).pipe(Effect.flip);
        expect(written).toHaveLength(before);
        expect(test.requests.map(({ operation }) => operation)).toEqual([
          "T3IssueReference",
          "T3Team",
          "T3LabelCandidates",
        ]);
      }
    }),
);

it.effect.each([5, 6])("bounds native Linear ancestor catalogs at five teams: %s", (count) =>
  Effect.gen(function* () {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const test = fakeLinear({
      T3Team: () => ({
        organization: ORGANIZATION,
        issueLabels: empty,
        teams: {
          nodes: [
            {
              id: "team_eng",
              key: "ENG",
              name: "Engineering",
              private: true,
              visibility: "private",
              restrictedBy: null,
              states: empty,
              labels: empty,
              members: empty,
              templates: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              ancestors: Array.from({ length: count }, (_, n) => ({
                id: `parent-${n}`,
                key: `P${n}`,
                name: "Parent",
                private: false,
                visibility: "public",
                restrictedBy: null,
                templates: empty,
                labels: empty,
              })),
            },
          ],
        },
      }),
    });
    const api = yield* test.tracker;
    if (count === 5) expect((yield* api.listCandidates(target)).truncated).toBe(false);
    else expect((yield* api.listCandidates(target).pipe(Effect.flip)).reason).toBe("failed");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
  }),
);

it.effect.each(["workspace", "ancestor"] as const)(
  "lists and creates native issue templates with an empty team catalog: %s",
  (source) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const plain = {
        id: "inherited-plain",
        name: "Bug",
        description: "Report a bug",
        content: "Steps",
        type: "issue",
        hasFormFields: false,
        templateData: { labelIds: ["native-label"] },
      };
      const form = { ...plain, id: "inherited-form", hasFormFields: true };
      const catalog = { ...empty, nodes: [plain, form] };
      const test = fakeLinear({
        T3Team: (variables) => {
          expect(variables.includeAncestorLabels).toBe(false);
          return {
            organization: { ...ORGANIZATION, templates: source === "workspace" ? catalog : empty },
            issueLabels: empty,
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  private: true,
                  visibility: "private",
                  restrictedBy: null,
                  states: empty,
                  labels: empty,
                  members: empty,
                  templates: empty,
                  ancestors:
                    source === "ancestor"
                      ? [
                          {
                            id: "parent",
                            key: "PARENT",
                            name: "Parent",
                            private: false,
                            visibility: "public",
                            restrictedBy: null,
                            templates: catalog,
                          },
                        ]
                      : [],
                },
              ],
            },
          };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ teamId: "team_eng", templateId: plain.id });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      expect(yield* api.listTemplates(target)).toMatchObject({
        templates: [{ key: plain.id, body: "Steps", labels: ["native-label"] }],
        externalTemplates: [
          { name: form.name, url: "https://linear.app/team/ENG/new?template=inherited-form" },
        ],
      });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
      test.requests.length = 0;
      yield* api.create({
        ...target,
        title: "New",
        body: "Steps",
        labels: [],
        assignees: [],
        templateKey: plain.id,
      });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team", "T3IssueCreate"]);
      for (const key of [form.id, "foreign-template"]) {
        test.requests.length = 0;
        expect(
          (yield* api
            .create({
              ...target,
              title: "New",
              body: "",
              labels: [],
              assignees: [],
              templateKey: key,
            })
            .pipe(Effect.flip)).reason,
        ).toBe("failed");
        expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
      }
    }),
);

it.effect.each(["workspace", "team", "ancestor"] as const)(
  "does not claim a complete template list from a partial native catalog: %s",
  (partial) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const catalog = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more-native" } };
      const test = fakeLinear({
        T3Team: () => ({
          organization: { ...ORGANIZATION, templates: partial === "workspace" ? catalog : empty },
          issueLabels: empty,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                states: empty,
                labels: empty,
                members: empty,
                templates: partial === "team" ? catalog : empty,
                ancestors: [
                  {
                    id: "parent",
                    key: "PARENT",
                    name: "Parent",
                    private: false,
                    visibility: "public",
                    restrictedBy: null,
                    labels: empty,
                    templates: partial === "ancestor" ? catalog : empty,
                  },
                ],
              },
            ],
          },
        }),
      });
      const api = yield* test.tracker;
      expect((yield* api.listTemplates(target).pipe(Effect.flip)).reason).toBe("failed");
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
    }),
);

it.effect.each([100, 101])("bounds native workspace template catalogs: %s", (count) =>
  Effect.gen(function* () {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const test = fakeLinear({
      T3Team: () => ({
        organization: {
          ...ORGANIZATION,
          templates: {
            ...empty,
            nodes: Array.from({ length: count }, (_, n) => ({
              id: `template-${n}`,
              name: "Bug",
              description: null,
              content: "Steps",
              type: "issue",
              hasFormFields: false,
              templateData: {},
            })),
          },
        },
        issueLabels: empty,
        teams: {
          nodes: [
            {
              id: "team_eng",
              key: "ENG",
              name: "Engineering",
              private: true,
              visibility: "private",
              restrictedBy: null,
              ancestors: [],
              states: empty,
              labels: empty,
              members: empty,
              templates: empty,
            },
          ],
        },
      }),
    });
    const api = yield* test.tracker;
    if (count === 100) expect((yield* api.listTemplates(target)).templates).toHaveLength(100);
    else expect((yield* api.listTemplates(target).pipe(Effect.flip)).reason).toBe("failed");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
  }),
);

it.effect("uses workspace-scoped native templates without accepting another team's template", () =>
  Effect.gen(function* () {
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const template = {
      id: "workspace-template",
      name: "Bug",
      description: null,
      content: "Steps",
      type: "issue",
      hasFormFields: false,
      templateData: {},
      teamId: null,
    };
    const nativeTemplates = [template, { ...template, id: "foreign-template", teamId: "team_ops" }];
    const test = fakeLinear({
      T3Team: (variables) => {
        expect(variables).toEqual({ key: "ENG", includeAncestorLabels: false });
        expect(compactQuery(test.requests.at(-1)?.query)).toContain(
          compactQuery(
            'organization { id urlKey templates(first: 100, filter: { type: { eq: "issue" } })',
          ),
        );
        expect(compactQuery(test.requests.at(-1)?.query)).toContain(
          compactQuery("teams(first: 1, filter: { key: { eq: $key } })"),
        );
        return {
          organization: {
            ...ORGANIZATION,
            templates: {
              ...empty,
              nodes: nativeTemplates.filter((entry) => entry.teamId === null),
            },
          },
          issueLabels: empty,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: true,
                visibility: "private",
                restrictedBy: null,
                ancestors: [],
                states: empty,
                labels: empty,
                members: empty,
                templates: empty,
              },
            ],
          },
        };
      },
    });
    const api = yield* test.tracker;
    expect((yield* api.listTemplates(target)).templates.map(({ key }) => key)).toEqual([
      template.id,
    ]);
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
    test.requests.length = 0;
    expect(
      (yield* api
        .create({
          ...target,
          title: "New",
          body: "",
          labels: [],
          assignees: [],
          templateKey: "foreign-template",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("failed");
    expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
  }),
);

it.effect.each(["create", "assignee", "clearLabels", "labelPage", "missingLabels"] as const)(
  "keeps ancestor metadata while selecting only needed labels: %s",
  (operation) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const parentLabel = labelFixture({ id: "parent-label", name: "Security", color: "#000" });
      const test = fakeLinear({
        T3Team: (variables) => {
          expect(variables.includeAncestorLabels).toBe(operation === "missingLabels");
          expect(compactQuery(test.requests.at(-1)?.query)).toContain(
            compactQuery("ancestors { id key name private visibility restrictedBy { id } labels("),
          );
          expect(compactQuery(test.requests.at(-1)?.query)).toContain(
            compactQuery(
              "labels(first: 250, includeArchived: true) @include(if: $includeAncestorLabels)",
            ),
          );
          return {
            organization: { ...ORGANIZATION, templates: empty },
            issueLabels: empty,
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  private: true,
                  visibility: "private",
                  restrictedBy: null,
                  states: empty,
                  labels: empty,
                  members: { ...empty, nodes: [THEO] },
                  templates: empty,
                  ancestors: [
                    {
                      id: "parent",
                      key: "PARENT",
                      name: "Parent",
                      private: false,
                      visibility: "public",
                      restrictedBy: null,
                      templates: empty,
                    },
                  ],
                },
              ],
            },
          };
        },
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ labelIds: [] });
          return {
            issueCreate: {
              success: true,
              issue: {
                identifier: "ENG-8",
                url: "https://linear.app/acme/issue/ENG-8",
              },
            },
          };
        },
        T3IssueUpdate: (variables) => {
          expect(variables.input).toEqual(
            operation === "assignee" ? { assigneeId: THEO.id } : { labelIds: [] },
          );
          return { issueUpdate: { success: true } };
        },
        T3LabelCandidates: (variables) => {
          expect(variables.filter).toEqual({
            and: [
              { or: [{ team: { id: { in: ["team_eng", "parent"] } } }, { team: { null: true } }] },
            ],
          });
          return {
            organization: ORGANIZATION,
            teams: { nodes: [{ id: "team_eng", key: "ENG", name: "Engineering" }] },
            issueLabels: { ...empty, nodes: [parentLabel] },
          };
        },
      });
      const api = yield* test.tracker;
      if (operation === "missingLabels") {
        expect((yield* api.listCandidates(target).pipe(Effect.flip)).reason).toBe("failed");
      } else if (operation === "labelPage") {
        expect((yield* api.listLabelCandidates(target)).items).toMatchObject([
          { id: parentLabel.id },
        ]);
      } else if (operation === "create") {
        yield* api.create({ ...target, title: "New", body: "", labels: [], assignees: [] });
      } else {
        yield* api.update({
          ...target,
          key: "ENG-7",
          ...(operation === "assignee" ? { assignees: [THEO.id] } : { labels: [] }),
        });
      }
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        ...(["assignee", "clearLabels"].includes(operation) ? ["T3IssueReference"] : []),
        "T3Team",
        ...(operation === "missingLabels"
          ? []
          : [
              operation === "labelPage"
                ? "T3LabelCandidates"
                : operation === "create"
                  ? "T3IssueCreate"
                  : "T3IssueUpdate",
            ]),
      ]);
    }),
);

it.effect.each([false, true])(
  "uses active workspace assignees only for public teams: private=%s",
  (privateTeam) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: privateTeam,
        visibility: privateTeam ? "private" : "public",
        restrictedBy: null,
        ancestors: [],
        states: empty,
        labels: empty,
        templates: empty,
        members: { ...empty, nodes: [JULIUS] },
      };
      const template = {
        id: "outsider-template",
        name: "Assigned",
        description: null,
        content: "",
        hasFormFields: false,
        type: "issue",
        templateData: { assigneeId: THEO.id },
      };
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: { nodes: [{ ...team, templates: { ...empty, nodes: [template] } }] },
          issueLabels: empty,
        }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3AssigneeCandidates: (variables) => ({
          organization: ORGANIZATION,
          teams: { nodes: [team] },
          ...(variables.publicTeam ? { users: { ...empty, nodes: [JULIUS, THEO] } } : {}),
        }),
        T3IssueCreate: () => ({
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
          },
        }),
        T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG" };
      const candidates = yield* api.listCandidates(scoped);
      expect(candidates.assignees.map(({ id }) => id)).toEqual(
        privateTeam ? [JULIUS.id] : [JULIUS.id, THEO.id],
      );
      expect(test.requests.map(({ operation }) => operation)).toEqual(
        privateTeam ? ["T3Team"] : ["T3Team", "T3AssigneeCandidates"],
      );
      test.requests.length = 0;
      expect((yield* api.listAssigneeCandidates(scoped)).items.map(({ id }) => id)).toEqual(
        privateTeam ? [JULIUS.id] : [JULIUS.id, THEO.id],
      );
      expect(test.requests).toHaveLength(2);
      const templates = yield* api.listTemplates(scoped);
      expect(templates.templates[0]?.assignees).toEqual([THEO.id]);
      for (const assignee of [THEO.id, JULIUS.id, null]) {
        for (const operation of ["create", "update"] as const) {
          test.requests.length = 0;
          const assignees = assignee === null ? [] : [assignee];
          const action =
            operation === "create"
              ? api.create({
                  ...scoped,
                  title: "New",
                  body: "",
                  labels: [],
                  assignees,
                  templateKey: template.id,
                })
              : api.update({ ...scoped, key: "ENG-7", assignees });
          if (privateTeam && assignee === THEO.id) {
            expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
            expect(test.requests.some(({ query }) => query.startsWith("mutation"))).toBe(false);
          } else {
            yield* action;
            expect(test.requests.at(-1)?.variables.input).toMatchObject({ assigneeId: assignee });
            expect(test.requests).toHaveLength(
              (operation === "create" ? 2 : 3) + (!privateTeam && assignee !== null ? 1 : 0),
            );
          }
        }
      }
      expect(test.requests.every(({ authorization }) => authorization === "lin_api_stored")).toBe(
        true,
      );
    }),
);

it.effect.each(["ENG", "acme/ENG"])(
  "allows parents in other teams in the observed workspace: %s",
  (scope) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const test = fakeLinear({
        T3IssueReference: ({ id }) => ({
          issue:
            id === "OPS-404"
              ? null
              : issue(
                  String(id),
                  id === "OTHER-8" ? { url: "https://linear.app/other/issue/OTHER-8" } : {},
                ),
        }),
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                private: false,
                visibility: "public",
                restrictedBy: null,
                ancestors: [],
                states: empty,
                labels: empty,
                members: empty,
                templates: empty,
              },
            ],
          },
        }),
        T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
        T3IssueCreate: () => ({
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" },
          },
        }),
      });
      const api = yield* test.tracker;
      const selected = { ...target, scope };
      yield* api.setParent({ ...selected, key: "ENG-7", parentKey: "OPS-8" });
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3IssueReference",
        "T3IssueReference",
        "T3IssueUpdate",
      ]);
      expect(test.requests.at(-1)?.variables).toEqual({
        id: "iss_ENG-7",
        input: { parentId: "iss_OPS-8" },
      });
      test.requests.length = 0;
      expect(
        yield* api.create({
          ...selected,
          title: "Child",
          body: "",
          labels: [],
          assignees: [],
          parentKey: "OPS-8",
        }),
      ).toMatchObject({ parentLinked: true });
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3Team",
        "T3IssueReference",
        "T3IssueCreate",
      ]);
      expect(test.requests.at(-1)?.variables.input).toMatchObject({
        teamId: "team_eng",
        parentId: "iss_OPS-8",
      });
      for (const parentKey of ["OTHER-8", "OPS-404"]) {
        for (const action of [
          api.setParent({ ...selected, key: "ENG-7", parentKey }),
          api.create({
            ...selected,
            title: "Child",
            body: "",
            labels: [],
            assignees: [],
            parentKey,
          }),
        ]) {
          test.requests.length = 0;
          yield* action.pipe(Effect.flip);
          expect(test.requests).toHaveLength(2);
          expect(test.requests.some(({ query }) => query.startsWith("mutation"))).toBe(false);
        }
      }
      test.requests.length = 0;
      yield* api.setParent({ ...selected, key: "OPS-7", parentKey: "OPS-8" }).pipe(Effect.flip);
      expect(test.requests).toHaveLength(1);
    }),
);

it.effect.each(["create", "update"] as const)(
  "resolves public workspace assignee IDs beyond 250 without a scan: %s",
  (operation) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: false,
        visibility: "public",
        restrictedBy: null,
        ancestors: [],
        states: empty,
        labels: empty,
        templates: empty,
        members: empty,
      };
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: { nodes: [team] },
        }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3AssigneeCandidates: ({ first }) => ({
          organization: ORGANIZATION,
          teams: { nodes: [team] },
          users:
            first === 1
              ? { ...empty, nodes: [THEO] }
              : {
                  nodes: Array.from({ length: 250 }, (_, n) => user(`other-${n}`, "Other")),
                  pageInfo: { hasNextPage: true, endCursor: "users-250" },
                },
        }),
        T3IssueCreate: () => ({
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
          },
        }),
        T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG", assignees: [THEO.id] };
      if (operation === "create")
        yield* api.create({ ...scoped, title: "New", body: "", labels: [] });
      else yield* api.update({ ...scoped, key: "ENG-7" });
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        ...(operation === "update" ? ["T3IssueReference"] : []),
        "T3Team",
        "T3AssigneeCandidates",
        "T3AssigneeCandidates",
        operation === "create" ? "T3IssueCreate" : "T3IssueUpdate",
      ]);
      expect(test.requests.at(-2)?.variables).toMatchObject({
        first: 1,
        after: null,
        filter: { active: { eq: true }, id: { eq: THEO.id } },
      });
      expect(test.requests.at(-1)?.variables.input).toMatchObject({ assigneeId: THEO.id });
    }),
);

it.effect.each(["inactive", "missing-privacy", "foreign-organization", "privacy-changed"] as const)(
  "refuses unavailable public-team assignees before writes: %s",
  (failure) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        ...(failure === "missing-privacy" ? {} : { private: false }),
        visibility: "public",
        restrictedBy: null,
        ancestors: [],
        states: empty,
        labels: empty,
        templates: empty,
        members: { ...empty, nodes: [JULIUS] },
      };
      const test = fakeLinear({
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: { nodes: [team] },
        }),
        T3AssigneeCandidates: ({ publicTeam }) => ({
          organization:
            failure === "foreign-organization" && publicTeam
              ? { ...ORGANIZATION, id: "org_other" }
              : ORGANIZATION,
          teams: {
            nodes: [
              {
                ...team,
                ...(failure === "privacy-changed" && publicTeam ? { private: true } : {}),
              },
            ],
          },
          ...(publicTeam
            ? { users: { ...empty, nodes: [{ ...THEO, active: failure !== "inactive" }] } }
            : {}),
        }),
      });
      const api = yield* test.tracker;
      if (failure === "inactive") {
        expect((yield* api.listCandidates(target)).assignees).toEqual([]);
        expect((yield* api.listAssigneeCandidates(target)).items).toEqual([]);
      } else {
        yield* api.listCandidates(target).pipe(Effect.flip);
        yield* api.listAssigneeCandidates(target).pipe(Effect.flip);
      }
      for (const action of [
        api.create({ ...target, title: "New", body: "", labels: [], assignees: [THEO.id] }),
        api.update({ ...target, key: "ENG-7", assignees: [THEO.id] }),
      ]) {
        test.requests.length = 0;
        expect((yield* action.pipe(Effect.flip)).reason).toBe("failed");
        expect(test.requests.some(({ query }) => query.startsWith("mutation"))).toBe(false);
      }
    }),
);

it.effect.each([false, true])(
  "continues only the active assignee connection with its cursor: private=%s",
  (privateTeam) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: privateTeam,
        visibility: privateTeam ? "private" : "public",
        restrictedBy: null,
        ancestors: [],
      };
      const test = fakeLinear({
        T3AssigneeCandidates: ({ publicTeam, readMembers, after }) => {
          const page =
            after === "users-250"
              ? { ...empty, nodes: [THEO] }
              : {
                  nodes: Array.from({ length: 200 }, (_, n) => user(`member-${n}`, "Member")),
                  pageInfo: { hasNextPage: true, endCursor: "users-250" },
                };
          return {
            organization: ORGANIZATION,
            teams: { nodes: [{ ...team, ...(readMembers ? { members: page } : {}) }] },
            ...(publicTeam ? { users: page } : {}),
          };
        },
      });
      const api = yield* test.tracker;
      const scoped = { ...target, scope: "acme/ENG", limit: 200 };
      const first = yield* api.listAssigneeCandidates(scoped);
      expect(first.items).toHaveLength(200);
      expect(first.nextCursor).toBe("users-250");
      const next = yield* api.listAssigneeCandidates({ ...scoped, cursor: first.nextCursor! });
      expect(next.items.map(({ id }) => id)).toEqual([THEO.id]);
      expect(next.nextCursor).toBeNull();
      expect(test.requests).toHaveLength(4);
      expect(
        test.requests.map(({ variables }) => [variables.publicTeam, variables.readMembers]),
      ).toEqual([
        [false, false],
        [!privateTeam, privateTeam],
        [false, false],
        [!privateTeam, privateTeam],
      ]);
      expect(test.requests[3]?.variables).toMatchObject({
        first: 200,
        after: "users-250",
        filter: { active: { eq: true } },
      });
      test.requests.length = 0;
      yield* api.listAssigneeCandidates({ ...scoped, scope: "other/ENG" }).pipe(Effect.flip);
      expect(test.requests).toHaveLength(1);
    }),
);

it.effect.each([401, 429])(
  "preserves native public assignee errors without a mutation: %s",
  (status) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: false,
        visibility: "public",
        restrictedBy: null,
        ancestors: [],
        states: empty,
        labels: empty,
        templates: empty,
        members: empty,
      };
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: { nodes: [team] },
        }),
        T3AssigneeCandidates: () => new Response("{}", { status }),
      });
      const api = yield* test.tracker;
      const error = yield* api
        .create({ ...target, title: "New", body: "", labels: [], assignees: [THEO.id] })
        .pipe(Effect.flip);
      expect(error.reason).toBe(status === 401 ? "unauthenticated" : "rate-limited");
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3Team",
        "T3AssigneeCandidates",
      ]);
    }),
);

it.effect.each(["cycle", "permission"] as const)("keeps native parent refusal: %s", (failure) =>
  Effect.gen(function* () {
    const test = fakeLinear({
      T3IssueReference: ({ id }) => ({ issue: issue(String(id)) }),
      T3IssueUpdate: () =>
        Response.json({
          errors: [
            {
              message: failure,
              extensions: { code: failure === "cycle" ? "BAD_USER_INPUT" : "FORBIDDEN" },
            },
          ],
        }),
    });
    const api = yield* test.tracker;
    const error = yield* api
      .setParent({ ...target, key: "ENG-7", parentKey: "OPS-8" })
      .pipe(Effect.flip);
    expect(error.reason).toBe("failed");
    expect(test.requests.map(({ operation }) => operation)).toEqual([
      "T3IssueReference",
      "T3IssueReference",
      "T3IssueUpdate",
    ]);
  }),
);

it.effect.each(["boundary", "child-guest", "parent-guest"] as const)(
  "uses restricted-team native membership within its nearest private boundary: %s",
  (membership) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const boundary = {
        id: "private-boundary",
        key: "PRIVATE",
        name: "Private",
        private: true,
        visibility: "private",
        restrictedBy: null,
        labels: empty,
        templates: empty,
      };
      const middle = {
        id: "restricted-parent",
        key: "MID",
        name: "Middle",
        private: false,
        visibility: "restricted",
        restrictedBy: { id: boundary.id },
        labels: empty,
        templates: empty,
      };
      const outer = { ...boundary, id: "outer-private", key: "OUTER" };
      const selected = { ...JULIUS, id: `usr_${membership}`, guest: membership !== "boundary" };
      const memberOf =
        membership === "boundary"
          ? boundary.id
          : membership === "parent-guest"
            ? middle.id
            : "team_eng";
      const template = {
        id: "restricted-template",
        name: "Assigned",
        description: null,
        content: "",
        hasFormFields: false,
        type: "issue",
        templateData: { assigneeId: selected.id },
      };
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        private: false,
        visibility: "restricted",
        restrictedBy: { id: boundary.id },
        ancestors: [outer, boundary, middle],
        states: empty,
        labels: empty,
        templates: { ...empty, nodes: [template] },
        members: { ...empty, nodes: membership === "child-guest" ? [selected] : [] },
      };
      let beyondPreview = false;
      let failure: string | null = null;
      const nativeTeam = (userPage = false) => ({
        ...team,
        ...(failure === "missing-visibility" ? { visibility: undefined } : {}),
        ...(failure === "unknown-visibility" ? { visibility: "unknown" } : {}),
        ...(failure === "missing-boundary" ? { restrictedBy: null } : {}),
        ...(failure === "missing-ancestors" ? { ancestors: [] } : {}),
        ...(failure === "wrong-boundary" ? { restrictedBy: { id: "foreign-boundary" } } : {}),
        ...(failure === "visibility-changed" && userPage
          ? { visibility: "public", restrictedBy: null }
          : {}),
      });
      const test = fakeLinear({
        T3Team: () => ({
          organization: ORGANIZATION,
          issueLabels: empty,
          teams: { nodes: [nativeTeam()] },
        }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3AssigneeCandidates: ({ publicTeam, membershipTeamIds, filter, after, first }) => {
          if (publicTeam) expect(membershipTeamIds).toEqual([boundary.id, middle.id, team.id]);
          const wanted = (filter as { id?: { eq: string } }).id?.eq;
          const preview = beyondPreview && !wanted && !after;
          const users = wanted
            ? wanted === selected.id
              ? [selected]
              : [THEO]
            : preview
              ? Array.from({ length: Number(first) }, (_, n) => user(`outsider-${n}`, "Other"))
              : after
                ? [selected]
                : [THEO, selected];
          return {
            organization: ORGANIZATION,
            teams: { nodes: [nativeTeam(Boolean(publicTeam))] },
            ...(publicTeam
              ? {
                  users: {
                    pageInfo: preview
                      ? { hasNextPage: true, endCursor: "raw-250" }
                      : empty.pageInfo,
                    nodes: users.map((user) => ({
                      ...user,
                      active:
                        user.id === selected.id && failure === "suspended" ? false : user.active,
                      ...(failure === "missing-membership"
                        ? {}
                        : {
                            teams: {
                              nodes: (membershipTeamIds as string[]).includes(
                                user.id === selected.id ? memberOf : outer.id,
                              )
                                ? [{ id: user.id === selected.id ? memberOf : outer.id }]
                                : [],
                            },
                          }),
                    })),
                  },
                }
              : {}),
          };
        },
        T3IssueCreate: () => ({
          issueCreate: {
            success: true,
            issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
          },
        }),
        T3IssueUpdate: () => ({ issueUpdate: { success: true } }),
      });
      const api = yield* test.tracker;
      expect((yield* api.listCandidates(target)).assignees.map(({ id }) => id)).toEqual([
        selected.id,
      ]);
      expect((yield* api.listAssigneeCandidates(target)).items.map(({ id }) => id)).toEqual([
        selected.id,
      ]);
      expect((yield* api.listTemplates(target)).templates[0]?.assignees).toEqual([selected.id]);
      for (const assignee of [selected.id, THEO.id]) {
        for (const action of [
          api.create({
            ...target,
            title: "New",
            body: "",
            labels: [],
            assignees: [assignee],
            templateKey: template.id,
          }),
          api.update({ ...target, key: "ENG-7", assignees: [assignee] }),
        ]) {
          test.requests.length = 0;
          if (assignee === selected.id) {
            yield* action;
            expect(test.requests.at(-1)?.variables.input).toMatchObject({
              assigneeId: selected.id,
            });
            expect(test.requests).toHaveLength(test.requests[0]?.operation === "T3Team" ? 3 : 4);
          } else {
            yield* action.pipe(Effect.flip);
            expect(test.requests.some(({ query }) => query.startsWith("mutation"))).toBe(false);
          }
        }
      }
      for (const action of [
        api.create({ ...target, title: "Blank", body: "", labels: [], assignees: [] }),
        api.update({ ...target, key: "ENG-7", assignees: [] }),
      ]) {
        test.requests.length = 0;
        yield* action;
        expect(test.requests.some(({ operation }) => operation === "T3AssigneeCandidates")).toBe(
          false,
        );
        expect(test.requests.at(-1)?.variables.input).toMatchObject({ assigneeId: null });
      }
      beyondPreview = true;
      const combined = yield* api.listCandidates(target);
      expect(combined.assignees).toEqual([]);
      expect(combined.truncated).toBe(true);
      const page = yield* api.listAssigneeCandidates({ ...target, limit: 200 });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBe("raw-250");
      const next = yield* api.listAssigneeCandidates({ ...target, cursor: page.nextCursor! });
      expect(next.items.map(({ id }) => id)).toEqual([selected.id]);
      expect(next.nextCursor).toBeNull();
      for (const action of [
        api.create({ ...target, title: "New", body: "", labels: [], assignees: [selected.id] }),
        api.update({ ...target, key: "ENG-7", assignees: [selected.id] }),
      ]) {
        test.requests.length = 0;
        yield* action;
        expect(test.requests.at(-2)?.variables).toMatchObject({
          first: 1,
          filter: { id: { eq: selected.id } },
          restricted: true,
          membershipTeamIds: [boundary.id, middle.id, team.id],
        });
        expect(test.requests).toHaveLength(test.requests[0]?.operation === "T3Team" ? 4 : 5);
      }
      beyondPreview = false;
      for (failure of [
        "missing-visibility",
        "unknown-visibility",
        "missing-boundary",
        "missing-ancestors",
        "wrong-boundary",
        "visibility-changed",
        "missing-membership",
        "suspended",
      ]) {
        for (const action of [
          api.create({ ...target, title: "New", body: "", labels: [], assignees: [selected.id] }),
          api.update({ ...target, key: "ENG-7", assignees: [selected.id] }),
        ]) {
          test.requests.length = 0;
          yield* action.pipe(Effect.flip);
          expect(test.requests.some(({ query }) => query.startsWith("mutation"))).toBe(false);
        }
      }
    }),
);

it.effect.each(["asc", "desc"] as const)(
  "pages native Linear comments and history globally in %s order with one request per page",
  (order) =>
    Effect.gen(function* () {
      const all = Array.from({ length: 105 }, (_, index) => {
        const number = 105 - index;
        return {
          id: `row-${number}`,
          createdAt: `2026-01-01T00:${String(Math.floor(number / 60)).padStart(2, "0")}:${String(number % 60).padStart(2, "0")}.000Z`,
        };
      });
      const connection = (variables: Record<string, unknown>, history: boolean) => {
        const start = variables.after == null ? 0 : Number(variables.after);
        const end = variables.before == null ? all.length : Number(variables.before);
        const from = variables.last == null ? start : Math.max(0, end - Number(variables.last));
        const to =
          variables.last == null ? Math.min(all.length, from + Number(variables.first)) : end;
        return {
          nodes: all.slice(from, to).map((row) =>
            history
              ? {
                  ...row,
                  actor: JULIUS,
                  fromState: null,
                  toState: null,
                  fromAssignee: null,
                  toAssignee: null,
                  addedLabels: null,
                  removedLabels: null,
                  fromTitle: null,
                  toTitle: row.id,
                }
              : {
                  ...row,
                  body: row.id,
                  editedAt: null,
                  url: `https://linear.app/acme/issue/ENG-7#${row.id}`,
                  user: JULIUS,
                  reactions: [],
                },
          ),
          pageInfo: {
            hasNextPage: to < all.length,
            endCursor: String(to),
            hasPreviousPage: from > 0,
            startCursor: String(from),
          },
        };
      };
      const test = fakeLinear({
        T3History: (variables) => ({
          issue: { ...issue("ENG-7"), history: connection(variables, true) },
        }),
        T3Comments: (variables) => ({
          issue: { ...issue("ENG-7"), comments: connection(variables, false) },
        }),
      });
      const api = yield* test.tracker;
      const input = { ...target, key: "ENG-7", connectionId: "selected-account", order, limit: 50 };
      for (const operation of ["history", "comments"] as const) {
        const first =
          operation === "history" ? yield* api.getHistory(input) : yield* api.getComments(input);
        const rows = "items" in first ? first.items : first.comments;
        expect(rows[0]?.id).toBe(
          `row-${order === "asc" ? 1 : 105}${operation === "history" ? ":title" : ""}`,
        );
        expect(rows).toHaveLength(50);
        expect(first.nextCursor).not.toBeNull();
        const secondInput = { ...input, cursor: first.nextCursor! };
        const second =
          operation === "history"
            ? yield* api.getHistory(secondInput)
            : yield* api.getComments(secondInput);
        const more = "items" in second ? second.items : second.comments;
        expect(more[0]?.id).toBe(
          `row-${order === "asc" ? 51 : 55}${operation === "history" ? ":title" : ""}`,
        );
        expect(more).toHaveLength(50);
        const last = test.requests.at(-1)!;
        expect(last.variables).toMatchObject(
          order === "asc"
            ? { first: null, last: 50, after: null, before: "55" }
            : { first: 50, last: null, after: "50", before: null },
        );
        expect(compactQuery(last.query)).toContain(
          compactQuery(
            `${operation === "history" ? "history" : "comments"}(first:$first,last:$last,after:$after,before:$before,orderBy:createdAt)`,
          ),
        );
        const count = test.requests.length;
        for (const changed of [
          { order: order === "asc" ? "desc" : "asc" },
          { key: "ENG-8" },
          { connectionId: "other-account" },
          { cwd: "/other" },
          { host: "other.example" },
          { scope: "OPS" },
          ...(operation === "history" ? [{ limit: 25 }] : []),
        ]) {
          const invalid = { ...secondInput, ...changed } as typeof secondInput;
          const failure =
            operation === "history"
              ? yield* api.getHistory(invalid).pipe(Effect.flip)
              : yield* api.getComments(invalid).pipe(Effect.flip);
          expect(failure.reason).toBe("failed");
        }
        expect(test.requests).toHaveLength(count);
      }
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3History",
        "T3History",
        "T3Comments",
        "T3Comments",
      ]);
    }),
);

it.effect.each(["getHistory", "getComments"] as const)(
  "preserves Retry-After on backward %s reads without extra HTTP calls",
  (operation) =>
    Effect.gen(function* () {
      const now = 1_750_000_000_000;
      yield* TestClock.setTime(now);
      const test = fakeLinear({
        [operation === "getHistory" ? "T3History" : "T3Comments"]: () =>
          new Response("limited", { status: 429, headers: { "retry-after": "20" } }),
      });
      const api = yield* test.tracker;
      const input = { ...target, key: "ENG-7", order: "asc" as const };
      const error =
        operation === "getHistory"
          ? yield* api.getHistory(input).pipe(Effect.flip)
          : yield* api.getComments(input).pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "rate-limited", retryAt: now + 20_000 });
      if (operation === "getHistory") yield* api.getHistory(input).pipe(Effect.flip);
      else yield* api.getComments(input).pipe(Effect.flip);
      expect(test.requests).toHaveLength(1);
      expect(test.requests[0]?.variables).toMatchObject({
        first: null,
        last: operation === "getHistory" ? 100 : 50,
        backward: true,
      });
    }),
);

it.effect.each(["getHistory", "getComments"] as const)(
  "rejects inconsistent native backward %s continuations with one HTTP call",
  (operation) =>
    Effect.gen(function* () {
      const test = fakeLinear({
        [operation === "getHistory" ? "T3History" : "T3Comments"]: () => ({
          issue: {
            ...issue("ENG-7"),
            [operation === "getHistory" ? "history" : "comments"]: {
              nodes: [],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
                hasPreviousPage: true,
                startCursor: null,
              },
            },
          },
        }),
      });
      const api = yield* test.tracker;
      const input = { ...target, key: "ENG-7", order: "asc" as const };
      const error =
        operation === "getHistory"
          ? yield* api.getHistory(input).pipe(Effect.flip)
          : yield* api.getComments(input).pipe(Effect.flip);
      expect(error).toMatchObject({
        reason: "failed",
        detail: "Linear returned an inconsistent page.",
      });
      expect(test.requests).toHaveLength(1);
    }),
);
