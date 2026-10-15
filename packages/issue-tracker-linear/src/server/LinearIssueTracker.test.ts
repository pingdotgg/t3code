import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
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
});
const JULIUS = user("usr_julius", "julius");
const THEO = user("usr_theo", "theo");
const ORGANIZATION = { id: "org_acme", urlKey: "acme" };

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
  creator: JULIUS,
  assignee: THEO,
  team: { key: identifier.split("-")[0] },
  labels: {
    nodes: [{ id: "lbl_bug", name: "Bug", color: "#f00" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  ...overrides,
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
        const parsed = JSON.parse(text) as { query: string; variables: Record<string, unknown> };
        const operation = /^(?:query|mutation) (\w+)/.exec(parsed.query)?.[1] ?? "?";
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

const target = { cwd: "/w/web", host: "linear.app", scope: "ENG" };

describe("LinearIssueTracker", () => {
  it.effect.each([
    { viewer: JULIUS.id, fails: false, mine: true, actors: [] },
    { viewer: JULIUS.id, fails: true, mine: true, actors: [] },
    { viewer: THEO.id, fails: false, mine: false, actors: ["julius"] },
    { viewer: undefined, fails: false, mine: true, actors: [] },
    { viewer: undefined, fails: true, mine: false, actors: ["julius"] },
  ])(
    "uses comment viewer $viewer with native viewer failure $fails",
    ({ viewer, fails, mine, actors }) =>
      Effect.gen(function* () {
        const test = fakeLinear({
          T3Viewer: () =>
            fails
              ? Response.json({ errors: [{ message: "Unavailable" }] }, { status: 500 })
              : { viewer: JULIUS },
          T3IssueReference: () => ({ issue: issue("ENG-7") }),
          T3IssueReactions: () => ({
            issue: {
              reactions: [
                { id: "native-viewer-reaction", emoji: "👍", user: JULIUS },
                { id: "display-viewer-reaction", emoji: "👍", user: THEO },
              ],
            },
          }),
          T3ReactionDelete: (variables) => {
            expect(variables.id).toBe("native-viewer-reaction");
            return { reactionDelete: { success: true } };
          },
          T3Comments: () => ({
            issue: issue("ENG-7", {
              comments: {
                nodes: [
                  {
                    id: "cmt_older",
                    body: "Older",
                    createdAt: "2026-07-01T00:00:00.000Z",
                    url: null,
                    user: JULIUS,
                    reactions: [{ id: "r1", emoji: "👍", user: JULIUS }],
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "oldest" },
              },
            }),
          }),
        });
        const api = yield* test.tracker;
        const result = yield* api.getComments({
          ...target,
          key: "ENG-7",
          cursor: "older",
          ...(viewer === undefined ? {} : { viewer }),
        });
        expect(result.nextCursor).toBe("oldest");
        expect(result.comments[0]?.reactions).toEqual([
          { content: "thumbs-up", count: 1, actors, viewerHasReacted: mine },
        ]);
        expect(test.requests.map((request) => request.operation)).toEqual(
          viewer === undefined ? ["T3Comments", "T3Viewer"] : ["T3Comments"],
        );
        expect(test.requests.every((request) => request.authorization === "lin_api_stored")).toBe(
          true,
        );
        if (viewer === THEO.id) {
          yield* api.setReaction({ ...target, key: "ENG-7", content: "thumbs-up", reacted: false });
          expect(test.requests.map((request) => request.operation)).toEqual([
            "T3Comments",
            "T3IssueReference",
            "T3Viewer",
            "T3IssueReactions",
            "T3ReactionDelete",
          ]);
        }
      }),
  );

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
      expect(detail.state).toEqual({
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
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [] },
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
        [api.getComments({ ...scoped, key: "ENG-7", cursor: "next" }), ["T3Comments", "T3Viewer"]],
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
      expect(test.requests[1]?.query).toContain("teams(first: 250)");
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
      expect(test.requests[0]?.query).toContain("labels(first: 20, includeArchived: true)");
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
      });
      const api = yield* test.tracker;
      expect((yield* api.getIssue({ ...target, key: "ENG-7" }).pipe(Effect.flip)).reason).toBe(
        "failed",
      );
      expect(
        (yield* api.getComments({ ...target, key: "ENG-7", cursor: "next" }).pipe(Effect.flip))
          .reason,
      ).toBe("failed");
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
                  url: null,
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
      expect(test.requests.find((request) => request.operation === "T3Issue")?.query).toContain(
        "labels(first: 100, includeArchived: true)",
      );
      expect(test.requests.find((request) => request.operation === "T3Issue")?.query).toContain(
        "history(first: 100",
      );
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
      expect((yield* api.viewer().pipe(Effect.flip)).detail).toBe("A field could not be read.");
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
      expect(page.items.map((item) => [item.key, item.displayKey, item.state])).toEqual([
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
                  url: null,
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
                  metadata,
                })),
                { url: "https://example.test/doc", title: "Doc", sourceType: null, metadata: null },
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
                  addedLabels: [{ id: "lbl_bug", name: "Bug", color: null }],
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
                templates: { nodes: [] },
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
  it.effect("retains archived labels and child labels while refusing native label groups", () =>
    Effect.gen(function* () {
      const old = { id: "lbl_old", name: "Old", color: null, archivedAt: "2026-01-01T00:00:00Z" };
      const group = { id: "lbl_type", name: "Type", color: null, archivedAt: null, isGroup: true };
      const bug = {
        id: "lbl_bug",
        name: "Bug",
        color: null,
        archivedAt: null,
        isGroup: false,
        parent: group,
      };
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
                states: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                labels: {
                  nodes: test.requests
                    .at(-1)
                    ?.query.includes("labels(first: 250, includeArchived: true)")
                    ? [old, group, bug]
                    : [group, bug],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                ancestors: [],
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: {
            nodes: test.requests
              .at(-1)
              ?.query.includes("issueLabels(first: 250, includeArchived: true")
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
        { id: bug.id, name: "Bug", color: null, description: null },
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
                  templates: { nodes: [] },
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
                  templates: { nodes: [] },
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
                templates: { nodes: [] },
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
  });
});

it.effect.each(["complete", "team", "workspace"] as const)(
  "retains the workspace Bug ID when adding another label: catalog=%s",
  (partial) =>
    Effect.gen(function* () {
      const teamBug = { id: "T", name: "Bug", color: null };
      const workspaceBug = { ...teamBug, id: "W" };
      const other = { id: "O", name: "Other", color: null };
      const writes: unknown[] = [];
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const test = fakeLinear({
        T3Issues: () => ({
          organization: ORGANIZATION,
          issues: {
            nodes: [issue("ENG-7", { labels: { ...empty, nodes: [workspaceBug] } })],
            pageInfo: empty.pageInfo,
          },
        }),
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3Team: () => ({
          organization: ORGANIZATION,
          teams: {
            nodes: [
              {
                id: "team_eng",
                key: "ENG",
                name: "Engineering",
                states: empty,
                members: empty,
                labels: {
                  nodes: [teamBug, other],
                  pageInfo: { hasNextPage: partial === "team", endCursor: "team-more" },
                },
                ancestors: [],
                templates: { nodes: [] },
              },
            ],
          },
          issueLabels: {
            nodes: [workspaceBug],
            pageInfo: { hasNextPage: partial === "workspace", endCursor: "workspace-more" },
          },
        }),
        T3IssueUpdate: (variables) => {
          writes.push(variables.input);
          return { issueUpdate: { success: true } };
        },
        T3IssueCreate: (variables) => {
          expect(variables.input).toMatchObject({ labelIds: ["W"] });
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
      });
      const api = yield* test.tracker;
      const page = yield* api.listIssues({
        ...target,
        state: "all",
        involvement: "all",
        viewer: "",
        limit: 50,
      });
      expect(page.items[0]?.labels).toEqual([{ id: "W", name: "Bug", color: null }]);
      const candidates = yield* api.listCandidates(target);
      expect(candidates.labels.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "T", name: "Bug" },
        { id: "O", name: "Other" },
        { id: "W", name: "Bug" },
      ]);
      test.requests.length = 0;
      yield* api.update({
        ...target,
        key: "ENG-7",
        labels: [page.items[0]!.labels[0]!.id!, other.id],
      });
      expect(writes).toEqual([{ labelIds: ["W", "O"] }]);
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3IssueReference",
        "T3Team",
        "T3IssueUpdate",
      ]);
      test.requests.length = 0;
      yield* api.create({ ...target, title: "New", body: "", labels: ["W"], assignees: [] });
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team", "T3IssueCreate"]);
      test.requests.length = 0;
      expect(
        (yield* api.update({ ...target, key: "ENG-7", labels: ["Bug", "Other"] }).pipe(Effect.flip))
          .detail,
      ).toContain("ambiguous");
      expect(writes).toHaveLength(1);
      expect(test.requests.map(({ operation }) => operation)).toEqual([
        "T3IssueReference",
        "T3Team",
      ]);
      if (partial !== "complete") {
        expect(
          (yield* api.update({ ...target, key: "ENG-7", labels: ["Other"] }).pipe(Effect.flip))
            .detail,
        ).toContain("incomplete");
        expect(writes).toHaveLength(1);
      }
    }),
);

it.effect.each(["create", "update"] as const)(
  "uses scoped native IDs beyond the initial 250 without scans: %s",
  (operation) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const labels = Array.from({ length: 250 }, (_, n) => ({
        id: n === 0 ? "O" : `label-${n}`,
        name: n === 0 ? "Other" : "Bug",
        color: null,
      }));
      const members = Array.from({ length: 250 }, (_, n) => user(`member-${n}`, "Same"));
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        states: empty,
        labels: { nodes: labels, pageInfo: { hasNextPage: true, endCursor: "labels-250" } },
        members: { nodes: members, pageInfo: { hasNextPage: true, endCursor: "members-250" } },
        ancestors: [],
        templates: { nodes: [] },
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
                { id: { in: ["W"] } },
              ],
            },
          });
          return {
            organization: ORGANIZATION,
            teams: { nodes: [team] },
            issueLabels: {
              nodes: [{ id: "W", name: "Same", color: null }],
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
            labelIds: ["W", "O"],
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
          expect(variables.input).toEqual({ labelIds: ["W", "O"], assigneeId: "member-250" });
          return { issueUpdate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      const selection = {
        ...target,
        scope: "acme/ENG",
        labels: ["W", "O"],
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
  "foreign-team",
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
      states: empty,
      labels: { ...empty, pageInfo: { hasNextPage: true, endCursor: "more" } },
      members: empty,
      ancestors: [],
      templates: { nodes: [] },
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
        teams: { nodes: [{ ...team, id: failure === "foreign-team" ? "other-team" : team.id }] },
        issueLabels: {
          nodes:
            failure === "missing"
              ? []
              : [
                  {
                    id: failure === "wrong-id" ? "other" : "chosen",
                    name: "Same",
                    color: null,
                    isGroup: failure === "group",
                  },
                  ...(failure === "duplicate" ? [{ id: "chosen", name: "Same", color: null }] : []),
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
        states: empty,
        labels: empty,
        members: { ...empty, pageInfo: { hasNextPage: true, endCursor: "more" } },
        ancestors: [],
        templates: { nodes: [] },
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

it.effect.each(["comment", "update", "state"] as const)(
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
      };
      yield* actions[operation];
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        "T3IssueReference",
        ...(operation === "state" ? ["T3TeamStates"] : []),
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
      const parentLabel = { id: "parent-security", name: "Security", color: null };
      const childLabel = { ...parentLabel, id: "child-security" };
      const other = { id: "other", name: "Other", color: null };
      const written: unknown[] = [];
      const team = {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        states: empty,
        members: empty,
        labels: { ...empty, nodes: [childLabel, other] },
        templates: { nodes: [] },
        ancestors: [
          {
            id: "team_parent",
            key: "PARENT",
            name: "Parent",
            labels: {
              nodes: [parentLabel],
              pageInfo: { hasNextPage: partial, endCursor: "parent-more" },
            },
          },
        ],
      };
      const test = fakeLinear({
        T3Team: (variables) => {
          expect(variables.includeAncestorLabels).toBe(true);
          return {
            organization: ORGANIZATION,
            teams: { nodes: [team] },
            issueLabels: empty,
          };
        },
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3LabelCandidates: (variables) => {
          const hidden = JSON.stringify(variables.filter).includes('"parent-hidden"');
          expect(variables).toEqual({
            key: "ENG",
            first: 1,
            after: null,
            filter: {
              and: [
                {
                  or: [
                    { team: { id: { in: ["team_eng", "team_parent"] } } },
                    { team: { null: true } },
                  ],
                },
                { id: { in: [hidden ? "parent-hidden" : "foreign"] } },
              ],
            },
          });
          return {
            organization: ORGANIZATION,
            teams: { nodes: [team] },
            issueLabels: {
              ...empty,
              nodes: hidden ? [{ ...parentLabel, id: "parent-hidden" }] : [],
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
      expect(candidates.labels.map(({ id }) => id)).toEqual([
        childLabel.id,
        other.id,
        parentLabel.id,
      ]);
      expect(candidates.truncated).toBe(partial);
      expect(test.requests.map(({ operation }) => operation)).toEqual(["T3Team"]);
      test.requests.length = 0;
      yield* api.update({ ...target, key: "ENG-7", labels: [parentLabel.id, other.id] });
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
              states: empty,
              labels: empty,
              members: empty,
              templates: { nodes: [] },
              ancestors: Array.from({ length: count }, (_, n) => ({
                id: `parent-${n}`,
                key: `P${n}`,
                name: "Parent",
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

it.effect.each(["templates", "create", "assignee", "clearLabels"] as const)(
  "skips unused ancestor label catalogs: %s",
  (operation) =>
    Effect.gen(function* () {
      const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      const writes: unknown[] = [];
      const test = fakeLinear({
        T3Team: (variables) => {
          expect(variables.includeAncestorLabels).toBe(false);
          return {
            organization: ORGANIZATION,
            teams: {
              nodes: [
                {
                  id: "team_eng",
                  key: "ENG",
                  name: "Engineering",
                  states: empty,
                  labels: empty,
                  members: { ...empty, nodes: [THEO] },
                  templates: { nodes: [] },
                },
              ],
            },
            issueLabels: empty,
          };
        },
        T3IssueReference: () => ({ issue: issue("ENG-7") }),
        T3IssueCreate: (variables) => {
          writes.push(variables.input);
          return {
            issueCreate: {
              success: true,
              issue: { identifier: "ENG-8", url: "https://linear.app/acme/issue/ENG-8" },
            },
          };
        },
        T3IssueUpdate: (variables) => {
          writes.push(variables.input);
          return { issueUpdate: { success: true } };
        },
      });
      const api = yield* test.tracker;
      const actions = {
        templates: api.listTemplates(target),
        create: api.create({ ...target, title: "New", body: "", labels: [], assignees: [] }),
        assignee: api.update({ ...target, key: "ENG-7", assignees: [THEO.id] }),
        clearLabels: api.update({ ...target, key: "ENG-7", labels: [] }),
      };
      yield* actions[operation];
      expect(test.requests.find(({ operation }) => operation === "T3Team")?.query).toContain(
        "ancestors @include(if: $includeAncestorLabels)",
      );
      expect(test.requests.map(({ operation: name }) => name)).toEqual([
        ...(["assignee", "clearLabels"].includes(operation) ? ["T3IssueReference"] : []),
        "T3Team",
        ...(operation === "templates"
          ? []
          : [operation === "create" ? "T3IssueCreate" : "T3IssueUpdate"]),
      ]);
      expect(writes).toEqual(
        operation === "templates"
          ? []
          : [
              operation === "create"
                ? { teamId: "team_eng", title: "New", description: "", labelIds: [] }
                : operation === "assignee"
                  ? { assigneeId: THEO.id }
                  : { labelIds: [] },
            ],
      );
    }),
);
