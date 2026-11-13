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
import { actor, assertRequestId, baseOid, decodeJson, encodeJson, fakeGitCafe, headOid, labels, pull, root, stack, target, timestamp } from "./GitCafePullRequestProvider.helpers2.testkit.ts";
import type { SentRequest } from "./GitCafePullRequestProvider.helpers2.testkit.ts";

describe("GitCafePullRequestProvider", () => {

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

  it.effect("reads the checks state from each check's newest run", () => {
    const run = (id: string, conclusion: string) => ({
      id,
      name: "Check",
      status: "completed",
      conclusion,
      summary: null,
      detailsUrl: null,
    });
    const items = [run("120859457782", "success"), run("120857059247", "failure")];
    const detailWith = (checks: (request: SentRequest) => unknown) => {
      const server = fakeGitCafe({
        "GET /repos/owner/repo/pulls/7": pull,
        "GET /repos/owner/repo/pulls/7/reviewers": { items: [], next: null },
        "GET /repos/owner/repo/pulls/7/labels": { items: [], next: null },
        "GET /repos/owner/repo/pulls/7/status": {
          merge: { conflicts: "none", fastForward: null, strategies: [] },
          // GitCafe counts the cancelled run's failure beside the re-run that passed.
          checks: { pending: 0, failing: 1, total: 2 },
        },
        [`GET /repos/owner/repo/commits/${headOid}/checks`]: checks,
        "GET /repos/owner/repo/pulls/7/changes": {
          version: 4,
          headOid,
          comparisonBaseOid: baseOid,
          items: [],
          next: null,
        },
      });
      return Effect.gen(function* () {
        const provider = yield* GitCafePullRequestProvider.make;
        return yield* provider.getChangeRequest(target);
      }).pipe(Effect.provide(server.layer));
    };
    return Effect.gen(function* () {
      const detail = yield* detailWith(() => ({ items, next: null }));
      assert.deepStrictEqual(
        detail.checks.map((check) => [check.name, check.status]),
        [["Check", "success"]],
      );
      assert.strictEqual(detail.checksState, "passing");

      // A listing cut off at the page limit may hide a failure, so GitCafe's counts decide.
      const truncated = yield* detailWith((request) => ({
        items,
        next: String(Number(request.query.get("after") ?? 0) + 1),
      }));
      assert.strictEqual(truncated.checksState, "failing");
    });
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

  const detailWith = (overrides: Record<string, unknown>, reasons: ReadonlyArray<string> = []) =>
    fakeGitCafe({
      "GET /repos/owner/repo/pulls/7": { ...pull, headOid: null, ...overrides },
      "GET /repos/owner/repo/pulls/7/reviewers": { items: [], next: null },
      "GET /repos/owner/repo/pulls/7/labels": { items: [], next: null },
      "GET /repos/owner/repo/pulls/7/status": {
        merge: { conflicts: "none", fastForward: null, strategies: ["squash"], reasons },
        checks: { pending: 0, failing: 0, total: 0 },
      },
    });

  it.effect("shows a merge GitCafe accepted as armed until it lands", () => {
    const server = detailWith({}, ["provider-merge-pending"]);
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.strictEqual(detail.autoMergeEnabled, true);
      assert.notInclude(detail.viewerPermissions?.actions ?? [], "merge");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads a pull request GitHub merged as merged before the sync reports it", () => {
    const mergedAt = "2026-09-12T13:00:00Z";
    const server = detailWith({ providerMerge: { mergedAt } });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.strictEqual(detail.state, "merged");
      assert.strictEqual(detail.mergedAt, mergedAt);
      const preview = yield* provider.getChangeRequestPreview!(target);
      assert.strictEqual(preview.state, "merged");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["their own pull request", actor],
    [
      "the pull request GitHub sync opened for them",
      {
        kind: "github",
        actorId: "act_github",
        login: "alice",
        avatarUrl: null,
        linkedProfile: { handle: "alice", actorId: "act_one" },
      },
    ],
  ] as const)("leaves the author only a comment on %s", ([, author]) => {
    const server = detailWith({ author, viewerActorId: "act_one" });
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.deepStrictEqual(detail.viewerPermissions?.verdicts, ["comment"]);
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
    const mainTip = "0123012301230123012301230123012301230123";
    let comparisonBaseOid = baseOid;
    let tips = { targetBranch: "main", observedBaseOid: baseOid };
    let pullReads = 0;
    let listingCut = true;
    let hunksDown = false;
    const hunks = (request: SentRequest) => ({
      version: 4,
      headOid,
      comparisonBaseOid,
      items: (request.body as { paths: ReadonlyArray<string> }).paths.map((path) => ({
        path,
        additions: comparisonBaseOid === baseOid ? 3 : 1,
        deletions: 1,
      })),
    });
    const server = fakeGitCafe({
      // A comment moves the version without moving the compared commits.
      "GET /repos/owner/repo/pulls/7": () => ({ ...pull, ...tips, version: 4 + pullReads++ }),
      "GET /repos/owner/repo/pulls/7/changes": (request: SentRequest) => ({
        version: 4,
        headOid,
        comparisonBaseOid,
        ...(!listingCut
          ? { items: [{ path: "a.ts" }, { path: "b.ts" }], next: null }
          : request.query.has("after")
            ? { items: [], next: "more" }
            : { items: [{ path: "a.ts" }], next: "more" }),
      }),
      get "POST /repos/owner/repo/pulls/7/diff-files"() {
        return hunksDown
          ? new Response(encodeJson({ type: "https://cafe.sh/errors/conflict" }), { status: 409 })
          : hunks;
      },
    });
    const reads = (suffix: string) =>
      server.sent.filter((request) => request.path.endsWith(suffix)).length;
    return Effect.gen(function* () {
      const provider = yield* GitCafePullRequestProvider.make;
      // A listing that stops before its last page holds nothing for its commits.
      yield* provider.getChangeRequestSummary!(target);
      listingCut = false;
      hunksDown = true;
      // Unread hunks leave the lines unknown, and are read again next time.
      const unread = yield* provider.getChangeRequestSummary!(target);
      assert.strictEqual(unread.additions, undefined);
      hunksDown = false;
      const first = yield* provider.getChangeRequestSummary!(target);
      const second = yield* provider.getChangeRequestSummary!(target);
      assert.deepInclude(first, { additions: 6, deletions: 2, changedFiles: 2 });
      assert.deepInclude(second, { additions: 6, deletions: 2, changedFiles: 2 });
      // Neither the head nor the target tip moved, so the file list is not read again.
      assert.deepStrictEqual([reads("/changes"), reads("/diff-files")], [4, 3]);
      // The target branch advancing keeps the merge base, so only the file list is read.
      tips = { ...tips, observedBaseOid: mainTip };
      const third = yield* provider.getChangeRequestSummary!(target);
      assert.deepInclude(third, { additions: 6, deletions: 2, changedFiles: 2 });
      assert.deepStrictEqual([reads("/changes"), reads("/diff-files")], [5, 3]);
      // A landed parent layer retargets the pull and moves the comparison base under the same head.
      comparisonBaseOid = landedBase;
      tips = { targetBranch: "trunk", observedBaseOid: mainTip };
      const fourth = yield* provider.getChangeRequestSummary!(target);
      assert.deepInclude(fourth, { additions: 2, deletions: 2, changedFiles: 2 });
      assert.deepStrictEqual([reads("/changes"), reads("/diff-files")], [6, 4]);
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
