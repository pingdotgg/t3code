import { assert, it } from "@effect/vitest";
import { IssueTrackerKind, SourceControlProviderKind } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const target = { cwd: "/repo", host: "git.example", scope: "owner/repo", key: "1" };
const listInput = {
  ...target,
  state: "open" as const,
  involvement: "all" as const,
  viewer: "alex",
  limit: 10,
};
const permissions = { setState: true, comment: true, edit: true, labels: true, assignees: true };

function tracker(
  kind: string,
  calls: string[],
  overrides: Partial<IssueTrackerApi> = {},
): IssueTrackerApi {
  const record = <A>(operation: string, host: string, value: A) => {
    calls.push(`${operation}:${host}`);
    return Effect.succeed(value);
  };
  return {
    kind: IssueTrackerKind.make(kind),
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: true,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    getViewer: (input) => record("getViewer", input.host, "alex"),
    listIssues: (input) => record("listIssues", input.host, { items: [], nextCursor: null }),
    getIssue: (input) =>
      record("getIssue", input.host, {
        key: input.key,
        displayKey: "#1",
        title: "Issue",
        url: "https://git.example/owner/repo/issues/1",
        author: null,
        state: { category: "open", name: "open" },
        createdAt: "2026-10-14T00:00:00Z",
        updatedAt: "2026-10-14T00:00:00Z",
        closedAt: null,
        assignees: [],
        labels: [],
        commentCount: 0,
        body: "",
        viewer: "alex",
        viewerPermissions: permissions,
        comments: [],
        commentsCursor: null,
        events: [],
        linkedPullRequests: [],
      }),
    getComments: (input) => record("getComments", input.host, { comments: [], nextCursor: null }),
    getViewerPermissions: (input) => record("getViewerPermissions", input.host, permissions),
    listTemplates: (input) =>
      record("listTemplates", input.host, { templates: [], blankIssuesEnabled: true }),
    listCandidates: (input) =>
      record("listCandidates", input.host, { labels: [], assignees: [], truncated: false }),
    comment: (input) => record("comment", input.host, undefined),
    getHistory: (input) => record("getHistory", input.host, { items: [], nextCursor: null }),
    getLinkedPullRequests: (input) =>
      record("getLinkedPullRequests", input.host, { items: [], nextCursor: null }),
    getHierarchy: (input) =>
      record("getHierarchy", input.host, {
        parent: null,
        children: { items: [], nextCursor: null },
      }),
    listLabelCandidates: (input) =>
      record("listLabelCandidates", input.host, { items: [], nextCursor: null }),
    listAssigneeCandidates: (input) =>
      record("listAssigneeCandidates", input.host, { items: [], nextCursor: null }),
    editComment: (input) => record("editComment", input.host, undefined),
    setParent: (input) => record("setParent", input.host, undefined),
    getDependencies: (input) =>
      record("getDependencies", input.host, { items: [], nextCursor: null }),
    setDependency: (input) => record("setDependency", input.host, undefined),
    ...overrides,
  };
}

it.effect.each(["gitlab", "azure-devops", "forgejo", "gitcafe"])(
  "honors PR host pauses before %s issue reads",
  (kind) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const retryAt = (yield* Clock.currentTimeMillis) + 60_000;
      const key = { provider: SourceControlProviderKind.make(kind), host: target.host };
      const lease = yield* limits.check(key);
      yield* limits.recordRateLimit({ ...key, lease, retryAt });
      const registry = yield* IssueTrackerRegistry.makeWithTrackers([tracker(kind, calls)]);
      const api = registry.get(IssueTrackerKind.make(kind))!;
      const reads: ReadonlyArray<Effect.Effect<unknown, IssueTrackerError>> = [
        api.getViewer(target),
        api.listIssues(listInput),
        api.getIssue(target),
        api.getComments({ ...target, cursor: "next" }),
        api.listTemplates!(target),
        api.listCandidates!(target),
        api.getHistory!(target),
        api.getLinkedPullRequests!(target),
        api.getHierarchy!(target),
        api.getDependencies!({ ...target, direction: "blocks" }),
        api.listLabelCandidates!(target),
        api.listAssigneeCandidates!(target),
      ];
      for (const read of reads) {
        const error = yield* Effect.flip(read.pipe(Effect.asVoid));
        assert.strictEqual(error.reason, "rate-limited");
        assert.strictEqual(error.retryAt, retryAt);
      }
      assert.deepStrictEqual(calls, []);
      yield* api.getViewer({ ...target, host: "other.example" });
      assert.deepStrictEqual(calls, ["getViewer:other.example"]);
    }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect.each([
  { kind: "gitlab", explicitRetry: false },
  { kind: "azure-devops", explicitRetry: false },
  { kind: "forgejo", explicitRetry: false },
  { kind: "gitcafe", explicitRetry: true },
  { kind: "gitlab", explicitRetry: true },
])(
  "records issue 429s for later PR and issue checks: $kind / $explicitRetry",
  ({ kind, explicitRetry }) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const now = yield* Clock.currentTimeMillis;
      const retryAt = now + 120_000;
      const failure = new IssueTrackerError({
        tracker: IssueTrackerKind.make(kind),
        operation: "listIssues",
        reason: "rate-limited",
        detail: "Try again later.",
        ...(explicitRetry ? { retryAt } : {}),
      });
      const registry = yield* IssueTrackerRegistry.makeWithTrackers([
        tracker(kind, calls, {
          listIssues: () => {
            calls.push("listIssues");
            return Effect.fail(failure);
          },
        }),
      ]);
      const api = registry.get(IssueTrackerKind.make(kind))!;
      const original = yield* Effect.flip(api.listIssues(listInput));
      assert.strictEqual(original, failure);
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const paused = yield* Effect.flip(
        limits.check({ provider: SourceControlProviderKind.make(kind), host: target.host }),
      );
      assert.strictEqual(paused.retryAt, explicitRetry ? retryAt : now + 30_000);
      const next = yield* Effect.flip(api.getViewer(target));
      assert.strictEqual(next.retryAt, paused.retryAt);
      assert.deepStrictEqual(calls, ["listIssues"]);
    }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("retains PR interactive-write permission policy during a host pause", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const key = { provider: SourceControlProviderKind.make("gitlab"), host: target.host };
    const lease = yield* limits.check(key);
    yield* limits.recordRateLimit({ ...key, lease });
    const registry = yield* IssueTrackerRegistry.makeWithTrackers([
      tracker("gitlab", calls, {
        comment: () =>
          SourceControlRateLimit.Interactive.pipe(
            Effect.flatMap((interactive) => {
              assert.strictEqual(interactive, true);
              return Effect.void;
            }),
          ),
      }),
    ]);
    const api = registry.get(IssueTrackerKind.make("gitlab"))!;
    yield* api.getViewerPermissions(target);
    yield* api.comment!({ ...target, body: "Hello" });
    const stillPaused = yield* Effect.flip(limits.check(key));
    assert.strictEqual(stillPaused._tag, "SourceControlRateLimitPausedError");
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect.each(["github", "linear", "jira"])("keeps %s native limiters untouched", (kind) =>
  Effect.gen(function* () {
    const native = tracker(kind, []);
    const registry = yield* IssueTrackerRegistry.makeWithTrackers([native]);
    assert.strictEqual(registry.get(IssueTrackerKind.make(kind)), native);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("allows explicit comment and parent writes during a shared host pause", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
    const key = { provider: SourceControlProviderKind.make("forgejo"), host: target.host };
    const lease = yield* limits.check(key);
    yield* limits.recordRateLimit({
      ...key,
      lease,
      retryAt: (yield* Clock.currentTimeMillis) + 60_000,
    });
    const registry = yield* IssueTrackerRegistry.makeWithTrackers([tracker("forgejo", calls)]);
    const api = registry.get(IssueTrackerKind.make("forgejo"))!;
    yield* api.editComment!({ ...target, commentId: "2", body: "Edited" });
    yield* api.setParent!({ ...target, parentKey: null });
    assert.deepStrictEqual(calls, ["editComment:git.example", "setParent:git.example"]);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("resets issue backoff after success without crossing accounts or hosts", () =>
  Effect.gen(function* () {
    let limited = true;
    const calls: string[] = [];
    const kind = IssueTrackerKind.make("gitlab");
    const failure = new IssueTrackerError({
      tracker: kind,
      operation: "getViewer",
      reason: "rate-limited",
      detail: "Try again later.",
    });
    const registry = yield* IssueTrackerRegistry.makeWithTrackers([
      tracker(kind, calls, {
        getViewer: ({ host }) =>
          Effect.suspend(() => {
            calls.push(host);
            return limited ? Effect.fail(failure) : Effect.succeed("alex");
          }),
      }),
    ]);
    const api = registry.get(kind)!;
    const request = api
      .getViewer(target)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "first"));
    assert.strictEqual(yield* Effect.flip(request), failure);
    assert.strictEqual((yield* Effect.flip(request)).retryAt, 30_000);
    limited = false;
    yield* api
      .getViewer(target)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "second"));
    yield* api
      .getViewer({ ...target, host: "other.example" })
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "first"));
    assert.strictEqual((yield* Effect.flip(request)).retryAt, 30_000);
    assert.deepStrictEqual(calls, [target.host, target.host, "other.example"]);
    yield* TestClock.adjust("30 seconds");
    yield* request;
    limited = true;
    assert.strictEqual(yield* Effect.flip(request), failure);
    assert.strictEqual((yield* Effect.flip(request)).retryAt, 60_000);
    assert.strictEqual(calls.length, 5);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);

it.effect("keeps a newer issue pause when an older successful read finishes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const kind = IssueTrackerKind.make("gitlab");
    const failure = new IssueTrackerError({
      tracker: kind,
      operation: "getViewer",
      reason: "rate-limited",
      detail: "Try again later.",
    });
    const registry = yield* IssueTrackerRegistry.makeWithTrackers([
      tracker(kind, [], {
        getViewer: ({ cwd }) =>
          cwd === "/slow"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("alex"),
              )
            : Effect.fail(failure),
      }),
    ]);
    const api = registry.get(kind)!;
    const older = yield* api.getViewer({ ...target, cwd: "/slow" }).pipe(Effect.forkChild());
    yield* Deferred.await(started);
    assert.strictEqual(yield* Effect.flip(api.getViewer(target)), failure);
    yield* TestClock.adjust("31 seconds");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(older);
    assert.strictEqual(yield* Effect.flip(api.getViewer(target)), failure);
    assert.strictEqual((yield* Effect.flip(api.getViewer(target))).retryAt, 91_000);
  }).pipe(Effect.provide(SourceControlRateLimit.layer)),
);
