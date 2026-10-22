import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafePullRequestProvider from "./GitCafePullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly body: unknown;
  readonly redirect: string | undefined;
}

function fakeGitCafe(
  routes: Record<string, unknown | ((request: SentRequest) => unknown)>,
  options: { readonly status?: number; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const sent: Array<SentRequest> = [];
  const client = HttpClient.make(
    (request: HttpClientRequest.HttpClientRequest, _url, _signal, fiber) => {
      const url = new URL(request.url);
      assert.isTrue(url.pathname.startsWith("/api/"), url.pathname);
      assert.strictEqual(request.headers.authorization, "Bearer env-token");
      const entry: SentRequest = {
        method: request.method,
        path: url.pathname.slice("/api".length),
        query: url.searchParams,
        host: url.host,
        body:
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      };
      sent.push(entry);
      const route = routes[`${entry.method} ${entry.path}`];
      const response =
        route === undefined
          ? new Response(encodeJson({ type: "https://cafe.sh/errors/not-found" }), { status: 404 })
          : route instanceof Response
            ? route
            : new Response(encodeJson(typeof route === "function" ? route(entry) : route), {
                status: options.status ?? 200,
              });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    },
  );
  const layer = GitCafeApi.layer.pipe(
    Layer.provide(GitCafeCredentials.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, options.env ?? { CAFE_TOKEN: "env-token" }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const writes = () =>
    sent.filter((request) => request.method !== "GET").map((r) => `${r.method} ${r.path}`);
  return { layer, sent, writes };
}

const target = { cwd: "/repo", host: "git.cafe", repository: "owner/repo", number: 7 };
const timestamp = "2026-09-12T12:00:00Z";
const headOid = "0123456789abcdef0123456789abcdef01234567";
const baseOid = "89abcdef0123456789abcdef0123456789abcdef";
const actor = {
  kind: "local",
  actorId: "act_one",
  handle: "alice",
  displayName: null,
  avatarUrl: "/avatars/one",
};
const pull = {
  id: "pr_one",
  number: 7,
  title: "Change",
  state: "open",
  draft: false,
  sourceBranch: "feature",
  targetBranch: "main",
  headOid,
  observedBaseOid: baseOid,
  mergeRoute: "provider",
  author: actor,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 4,
  description: "Body",
  closedAt: null,
  mergedAt: null,
  sourceRepo: null,
  capabilities: { comment: true, review: true, merge: true, edit: true, moderate: true },
};
const labels = [
  { id: "label_bug", name: "bug", color: "#d73a4a", description: null },
  { id: "label_docs", name: "docs", color: "#0075ca", description: "Documentation" },
];
const root = {
  id: "root",
  threadId: "root",
  version: 2,
  author: actor,
  body: "Review",
  path: "file.ts",
  line: 3,
  side: "right",
  createdAt: timestamp,
  commitOid: headOid,
  resolvedAt: null,
  capabilities: {
    edit: true,
    hide: false,
    unhide: false,
    delete: false,
    resolve: true,
    unresolve: false,
  },
};
const stack = (
  members: ReadonlyArray<{ number: number; headOid: string; state?: string }>,
): Record<string, unknown> => ({
  "GET /repos/owner/repo/pulls/7/stack": {
    stack: {
      id: "stack-one",
      number: 3,
      revision: 5,
      landingBase: "main",
      members: members.map((member, index) => ({
        pullRequestNumber: member.number,
        title: `Layer ${member.number}`,
        state: member.state ?? "open",
        draft: false,
        sourceBranch: `layer-${member.number}`,
        position: index + 1,
      })),
    },
  },
  ...Object.fromEntries(
    members.map((member) => [
      `GET /repos/owner/repo/pulls/${member.number}`,
      { ...pull, number: member.number, headOid: member.headOid },
    ]),
  ),
});

const assertRequestId = (body: unknown) =>
  assert.match(
    (body as { readonly requestId?: unknown } | undefined)?.requestId as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

describe("GitCafePullRequestProvider", () => {
  it.effect("keeps a staging repository's requests and links on staging", () => {
    // CAFE_TOKEN follows CAFE_HOST, so staging reads the env token only when it is the target.
    const server = fakeGitCafe(
      { "GET /repos/owner/repo/pulls/7": pull },
      { env: { CAFE_TOKEN: "env-token", CAFE_HOST: "staging.git.cafe" } },
    );
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const summary = yield* provider.getChangeRequestSummary!({
        ...target,
        host: "staging.git.cafe",
      });
      assert.strictEqual(summary.url, "https://staging.git.cafe/owner/repo/pulls/7");
      assert.isTrue(server.sent.every((request) => request.host === "staging.git.cafe"));
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses a repository outside GitCafe's hosts before sending anything", () => {
    const server = fakeGitCafe({});
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .getChangeRequest({ ...target, host: "github.com" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reports a refused token as unauthenticated and a limit as rate-limited", () =>
    Effect.gen(function* () {
      for (const [status, reason] of [
        [401, "unauthenticated"],
        [429, "rate-limited"],
      ] as const) {
        const server = fakeGitCafe(
          { "GET /repos/owner/repo/pulls/7/stack": { stack: null } },
          {
            status,
          },
        );
        const error = yield* GitCafePullRequestProvider.make.pipe(
          Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
          Effect.flip,
          Effect.provide(server.layer),
        );
        assert.strictEqual(error.reason, reason);
      }
    }),
  );

  it.effect("never lets fetch follow a redirect with the token", () => {
    const server = fakeGitCafe({ "GET /repos/owner/repo/pulls/7/stack": { stack: null } });
    return GitCafePullRequestProvider.make.pipe(
      Effect.flatMap((provider) => provider.getChangeRequestStack!(target)),
      Effect.tap(() =>
        Effect.sync(() =>
          assert.deepStrictEqual(
            server.sent.map((r) => r.redirect),
            ["manual"],
          ),
        ),
      ),
      Effect.provide(server.layer),
    );
  });

  it.effect("reads the stack a pull request belongs to, with each open layer's head", () => {
    const { "GET /repos/owner/repo/pulls/6": _merged, ...routes } = stack([
      { number: 6, headOid: baseOid, state: "merged" },
      { number: 7, headOid },
    ]);
    const server = fakeGitCafe(routes);
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getChangeRequestStack!(target);
      assert.strictEqual(result?.number, 3);
      assert.deepStrictEqual(
        result?.layers.map((layer) => [layer.number, layer.headSha]),
        [
          [6, undefined],
          [7, headOid],
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("resolves a thread through its root at the root's version", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7/comments": { items: [root], next: null },
      "POST /repos/owner/repo/pulls/7/comments/root/resolve": {
        id: "root",
        threadId: "root",
        version: 3,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.setThreadResolution({ ...target, threadId: "root", resolved: true });
      assert.deepStrictEqual(server.writes(), [
        "POST /repos/owner/repo/pulls/7/comments/root/resolve",
      ]);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 2 });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("submits a review against the pull request's current head", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/reviews": { id: "review-1" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.submitReview({
        ...target,
        verdict: "request-changes",
        body: "Please fix",
        comments: [],
      });
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/reviews"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        verdict: "request_changes",
        body: "Please fix",
        commitOid: headOid,
      });
      assertRequestId(server.sent.at(-1)?.body);

      // GitCafe rejects a null body; an empty review leaves it out.
      yield* provider.submitReview({ ...target, verdict: "approve", body: "", comments: [] });
      assert.notProperty(server.sent.at(-1)?.body as object, "body");
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["completed", true],
    ["failed", false],
  ] as const)("merges synchronously and reads a %s outcome", ([state, succeeds]) => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "POST /repos/owner/repo/pulls/7/merge": { id: "merge-1", state, reason: "Blocked" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .runAction({ ...target, action: "merge", mergeMethod: "squash" })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, succeeds ? "Success" : "Failure");
      assert.deepStrictEqual(server.writes(), ["POST /repos/owner/repo/pulls/7/merge"]);
      assert.deepInclude(server.sent.at(-1)?.body as object, {
        strategy: "squash",
        headOid,
        expectedVersion: 4,
      });
      assertRequestId(server.sent.at(-1)?.body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "lands a stack through a layer only while its heads are the ones the reader saw",
    () => {
      const layers = [
        { number: 6, headOid: baseOid },
        { number: 7, headOid },
      ];
      const server = fakeGitCafe({
        ...stack(layers),
        "POST /repos/owner/repo/pulls/stacks/3/land-through": {
          id: "land-1",
          state: "completed",
          landedCount: 2,
          stepCount: 2,
          stopReason: null,
          error: null,
          steps: [],
        },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const heads = layers.map((layer) => ({ number: layer.number, headSha: layer.headOid }));
        const stale = yield* provider
          .runAction({
            ...target,
            action: "merge",
            stackNumber: 3,
            expectedStackHeads: [heads[0]!, { number: 7, headSha: baseOid }],
          })
          .pipe(Effect.result);
        assert.strictEqual(stale._tag, "Failure");
        assert.deepStrictEqual(server.writes(), []);

        yield* provider.runAction({
          ...target,
          action: "merge",
          stackNumber: 3,
          expectedStackHeads: heads,
          mergeMethod: "merge",
        });
        assert.deepStrictEqual(server.writes(), [
          "POST /repos/owner/repo/pulls/stacks/3/land-through",
        ]);
        assert.deepInclude(server.sent.at(-1)?.body as object, {
          expectedRevision: 5,
          throughPullRequestNumber: 7,
          strategy: "merge",
        });
        assertRequestId(server.sent.at(-1)?.body);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each([
    ["authored", "authors"],
    ["reviewing", "reviewers"],
  ] as const)("filters %s pull requests by the viewer's actor on GitCafe", ([involvement, key]) => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/filter-options": {
        actors: [{ actorId: "act_one", handle: "Alice" }],
      },
      "GET /repos/owner/repo/pulls": { items: [pull], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement,
        viewer: "alice",
        limit: 10,
      });
      assert.strictEqual(server.sent.at(-1)?.query.get(key), '["act_one"]');
      assert.strictEqual(
        page.items[0]?.reviewRequestLogins.includes("alice"),
        involvement === "reviewing",
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("lists nothing for a viewer GitCafe has no actor for", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/filter-options": { actors: [] },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "authored",
        viewer: "alice",
        limit: 10,
      });
      assert.deepStrictEqual(page.items, []);
      assert.deepStrictEqual(
        server.sent.map((request) => request.path),
        ["/repos/owner/repo/filter-options"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each(["authored", "reviewing"] as const)(
    "lists %s unnarrowed when GitCafe can't say who the viewer is",
    (involvement) => {
      const server = fakeGitCafe({ "GET /repos/owner/repo/pulls": { items: [pull], next: null } });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        const page = yield* provider.listChangeRequests({
          ...target,
          state: "open",
          involvement,
          viewer: "alice",
          limit: 10,
        });
        const listing = server.sent.find((request) => request.path === "/repos/owner/repo/pulls");
        assert.isDefined(listing);
        assert.isNull(listing!.query.get(involvement === "reviewing" ? "reviewers" : "authors"));
        assert.notInclude(page.items[0]?.reviewRequestLogins ?? [], "alice");
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("reads line counts, open merge strategies, reviewers and labels", () => {
    const snapshot = { version: 4, headOid, comparisonBaseOid: baseOid };
    const files = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ path: `f${from + index}.ts` }));
    let changePage = 0;
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/reviewers": { items: [{ id: "act_one", actor }], next: null },
      "GET /repos/owner/repo/pulls/7/labels": { items: [labels[0]], next: null },
      "GET /repos/owner/repo/pulls/7/status": {
        merge: {
          conflicts: "none",
          fastForward: true,
          strategies: ["merge", "squash", "rebase"],
          blockers: [{ blockedStrategies: ["squash"] }, {}],
        },
        checks: { pending: 0, failing: 0, total: 0 },
      },
      [`GET /repos/owner/repo/commits/${headOid}/checks`]: (request: SentRequest) => ({
        items: [
          {
            name: request.query.has("after") ? "late" : "early",
            status: "completed",
            conclusion: request.query.has("after") ? "failure" : "success",
            summary: null,
            detailsUrl: null,
          },
        ],
        next: request.query.has("after") ? null : "checks-1",
      }),
      "GET /repos/owner/repo/pulls/7/changes": () =>
        changePage++ === 0
          ? { ...snapshot, items: files(0, 2), next: "cursor-1" }
          : { ...snapshot, items: files(2, 1), next: null },
      "POST /repos/owner/repo/pulls/7/diff-files": (request: SentRequest) => ({
        ...snapshot,
        items: (request.body as { paths: ReadonlyArray<string> }).paths.map((path) => ({
          path,
          additions: 2,
          deletions: 1,
        })),
      }),
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.deepInclude(detail, {
        additions: 6,
        deletions: 3,
        changedFiles: 3,
        mergeability: "mergeable",
      });
      assert.strictEqual(
        server.sent.filter((request) => request.path.endsWith("/changes"))[1]?.query.get("after"),
        "cursor-1",
      );
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: false,
        rebase: true,
      });
      assert.deepStrictEqual(
        detail.checks.map((check) => check.name),
        ["late", "early"],
      );
      assert.deepStrictEqual(
        detail.reviewers.map((reviewer) => reviewer.login),
        ["alice"],
      );
      assert.deepStrictEqual(detail.reviewRequestLogins, ["alice"]);
      assert.deepStrictEqual(detail.labels, [{ name: "bug", color: "#d73a4a" }]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("still reads a pull request whose reviewers the token may not see", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, headOid: null },
      "GET /repos/owner/repo/pulls/7/reviewers": new Response(
        encodeJson({ type: "https://cafe.sh/errors/forbidden" }),
        { status: 403 },
      ),
      "GET /repos/owner/repo/pulls/7/labels": { items: [labels[0]], next: null },
      "GET /repos/owner/repo/pulls/7/status": {
        merge: { conflicts: "unknown", fastForward: null, strategies: [] },
        checks: { pending: 0, failing: 0, total: 0 },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.deepStrictEqual(detail.reviewers, []);
      assert.deepStrictEqual(detail.labels, [{ name: "bug", color: "#d73a4a" }]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("fails the detail rather than hide reviewers GitCafe could not serve", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, headOid: null },
      "GET /repos/owner/repo/pulls/7/reviewers": new Response("", { status: 503 }),
      "GET /repos/owner/repo/pulls/7/labels": { items: [], next: null },
      "GET /repos/owner/repo/pulls/7/status": {
        merge: { conflicts: "unknown", fastForward: null, strategies: [] },
        checks: { pending: 0, failing: 0, total: 0 },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider.getChangeRequest(target).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("requests and withdraws reviewers by rewriting the whole list", () => {
    const bob = { ...actor, actorId: "act_two", handle: "bob" };
    let requested = [{ id: "act_two", actor: bob }];
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/reviewer-candidates": {
        items: [
          { id: "act_one", actor },
          { id: "act_two", actor: bob },
          { id: "act_bot", actor: { ...actor, actorId: "act_bot", handle: "lint", bot: true } },
        ],
        next: null,
      },
      "GET /repos/owner/repo/pulls/7/reviewers": () => ({ items: requested, next: null }),
      "PUT /repos/owner/repo/pulls/7/reviewers": { version: 5, items: [] },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const list = yield* provider.listReviewerCandidates(target);
      // The author, alice, cannot review her own pull request.
      assert.deepStrictEqual(
        list.candidates.map((c) => [c.id, c.login, c.isRequested, c.isBot ?? false]),
        [
          ["act_two", "bob", true, false],
          ["act_bot", "lint", false, true],
        ],
      );

      const set = (id: string, on: boolean) =>
        provider.setReviewerRequest({
          ...target,
          reviewers: [{ id, kind: "user" }],
          requested: on,
        });
      yield* set("act_bot", true);
      assert.deepStrictEqual(server.sent.at(-1)?.body, {
        expectedVersion: 4,
        actorIds: ["act_two", "act_bot"],
      });
      yield* set("act_two", false);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 4, actorIds: [] });

      requested = [];
      yield* set("act_two", false);
      assert.strictEqual(server.writes().length, 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("names the missing scopes when the token may not request reviewers", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/pulls/7/reviewer-candidates": new Response("", { status: 403 }),
      "GET /repos/owner/repo/pulls/7/reviewers": { items: [], next: null },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const error = yield* Effect.flip(provider.listReviewerCandidates(target));
      assert.match(error.detail, /pr:reviewers:write/u);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("applies and removes labels by name through their ids", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": pull,
      "GET /repos/owner/repo/labels": { items: labels, next: null },
      "GET /repos/owner/repo/pulls/7/labels": { items: [labels[0]], next: null },
      "PUT /repos/owner/repo/pulls/7/labels": { version: 5, items: [] },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const list = yield* provider.listLabelCandidates!(target);
      assert.deepStrictEqual(
        list.candidates.map((label) => [label.name, label.isApplied]),
        [
          ["bug", true],
          ["docs", false],
        ],
      );

      yield* provider.setLabels!({ ...target, labels: ["docs"], applied: true });
      assert.deepStrictEqual(server.sent.at(-1)?.body, {
        expectedVersion: 4,
        labelIds: ["label_bug", "label_docs"],
      });
      yield* provider.setLabels!({ ...target, labels: ["bug"], applied: false });
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedVersion: 4, labelIds: [] });

      const missing = yield* provider.setLabels!({
        ...target,
        labels: ["nope"],
        applied: true,
      }).pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      assert.strictEqual(server.writes().length, 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("recounts summary lines only when the compared commits move", () => {
    const landedBase = "fedcba9876543210fedcba9876543210fedcba98";
    let comparisonBaseOid = baseOid;
    let pullReads = 0;
    const server = fakeGitCafe({
      // A comment moves the version without moving the compared commits.
      "GET /repos/owner/repo/pulls/7": () => ({ ...pull, version: 4 + pullReads++ }),
      "GET /repos/owner/repo/pulls/7/changes": () => ({
        version: 4,
        headOid,
        comparisonBaseOid,
        items: [{ path: "a.ts" }, { path: "b.ts" }],
        next: null,
      }),
      "POST /repos/owner/repo/pulls/7/diff-files": (request: SentRequest) => ({
        version: 4,
        headOid,
        comparisonBaseOid,
        items: (request.body as { paths: ReadonlyArray<string> }).paths.map((path) => ({
          path,
          additions: comparisonBaseOid === baseOid ? 3 : 1,
          deletions: 1,
        })),
      }),
    });
    const hunkReads = () =>
      server.sent.filter((request) => request.path.endsWith("/diff-files")).length;
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const first = yield* provider.getChangeRequestSummary!(target);
      const second = yield* provider.getChangeRequestSummary!(target);
      assert.deepInclude(first, { additions: 6, deletions: 2, changedFiles: 2 });
      assert.deepInclude(second, { additions: 6, deletions: 2, changedFiles: 2 });
      assert.strictEqual(hunkReads(), 1);
      // A landed parent layer moves the comparison base under the same head.
      comparisonBaseOid = landedBase;
      const third = yield* provider.getChangeRequestSummary!(target);
      assert.deepInclude(third, { additions: 2, deletions: 2, changedFiles: 2 });
      assert.strictEqual(hunkReads(), 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("fences a native merge on the target branch's current commit", () => {
    const branchOid = "fedcba9876543210fedcba9876543210fedcba98";
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, mergeRoute: "native", observedBaseOid: null },
      "GET /repos/owner/repo/commit": { oid: branchOid },
      "POST /repos/owner/repo/pulls/7/merge": { id: "merge-1", state: "completed" },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      yield* provider.runAction({ ...target, action: "merge" });
      const branchRead = server.sent.find((request) => request.path === "/repos/owner/repo/commit");
      assert.strictEqual(branchRead?.query.get("ref"), "refs/heads/main");
      assert.deepInclude(server.sent.at(-1)?.body as object, { baseOid: branchOid, headOid });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses to drop a reaction whose id it cannot address", () => {
    const server = fakeGitCafe({
      "GET /repos/owner/repo/pulls/7/reactions/": {
        items: [
          {
            subject: { kind: "pull_request_comment", id: "root" },
            emoji: { kind: "unicode", value: "🚀" },
            count: 1,
            viewerReactionId: "../escape",
            reactors: [actor],
          },
        ],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const result = yield* provider
        .setReaction({ ...target, subjectId: "root", content: "rocket", reacted: false })
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });
});
