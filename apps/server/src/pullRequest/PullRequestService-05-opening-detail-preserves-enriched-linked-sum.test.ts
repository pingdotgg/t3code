import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerSettings } from "@t3tools/contracts";
import * as ServerSettingsService from "../serverSettings.ts";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

import {
  project,
  changeRequest,
  hostedChangeRequest,
  requestFailed,
  FULL_REVIEW,
  FULL_REVIEWERS,
  makeService,
} from "./PullRequestService-fixtures.testkit.ts";

it.effect(
  "opening detail preserves enriched linked summaries and updates draft and diff fields",
  () =>
    Effect.gen(function* () {
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              Effect.succeed({
                ...changeRequest(1, "2026-07-02T00:00:00Z"),
                isDraft: true,
                reviewDecision: "approved",
                checksState: "passing",
              }),
            getChangeRequest: () =>
              Effect.succeed({
                ...hostedChangeRequest("body", 14),
                deletions: 3,
                changedFiles: 5,
                mergeability: "conflicting",
              }),
          }),
        ],
      });
      yield* service.summary(reference);
      const detail = yield* service.detail(reference);
      const summary = yield* service.summary(reference);
      assert.strictEqual(summary.isDraft, false);
      assert.deepStrictEqual(summary.author, detail.author);
      assert.strictEqual(summary.additions, 14);
      assert.strictEqual(summary.deletions, 3);
      assert.strictEqual(summary.changedFiles, 5);
      assert.strictEqual(summary.mergeability, "conflicting");
      assert.strictEqual(summary.reviewDecision, "approved");
      assert.strictEqual(summary.checksState, "passing");
    }),
);
it.effect("notifies linked threads when detail changes draft status in either direction", () =>
  Effect.gen(function* () {
    let isDraft = true;
    let updatedAt = "2026-07-02T00:00:00Z";
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.sync(() => ({ ...hostedChangeRequest("body"), isDraft, updatedAt })),
        }),
      ],
    });
    const changes = yield* service.subscribeStateChanges;
    const read = () => service.detail({ ...reference, allowStale: false });
    yield* read();
    yield* read();
    isDraft = false;
    yield* service.invalidate({ reference });
    yield* read();
    yield* read();
    isDraft = true;
    yield* service.invalidate({ reference });
    yield* read();

    isDraft = false;
    updatedAt = "2026-07-01T00:00:00Z";
    yield* service.invalidate({ reference });
    yield* read();

    // A different PR ends collection after all the synchronous notifications above.
    yield* service.reportState({ reference: { ...reference, number: 2 }, state: "open" });
    const events = yield* Stream.runCollect(
      changes.pipe(Stream.takeUntil((event) => event.number === 2, { excludeLast: true })),
    );
    assert.deepStrictEqual(events, [
      { host: "github.com", repository: "acme/web", number: 1 },
      { host: "github.com", repository: "acme/web", number: 1 },
      { host: "github.com", repository: "acme/web", number: 1 },
    ]);
  }),
);
it.effect("deduplicates routed PR reports without dropping draft changes", () =>
  Effect.gen(function* () {
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("github"))],
    });
    const changes = yield* service.subscribeStateChanges;
    for (const isDraft of [true, true, false, false, true]) {
      yield* service.reportState({ reference, state: "open", isDraft });
    }
    yield* service.reportState({ reference, state: "open" });
    yield* service.reportState({ reference, state: "open" });
    yield* service.reportState({ reference: { ...reference, number: 2 }, state: "open" });
    const events = yield* Stream.runCollect(
      changes.pipe(Stream.takeUntil((event) => event.number === 2, { excludeLast: true })),
    );
    assert.deepStrictEqual(
      events.map((event) => event.number),
      [1, 1, 1, 1],
    );
  }),
);
it.effect(
  "reuses fresh detail checks without extending their refresh interval on detail cache hits",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequest: () => Effect.succeed(hostedChangeRequest("Description")),
            getChangeRequestChecks: () =>
              Effect.sync(() => {
                reads += 1;
                return { state: "closed" as const, checks: [] };
              }),
          }),
        ],
      });
      yield* TestClock.setTime(1_000);
      const detail = yield* service.detail(reference);
      expect(yield* service.checks(reference)).toEqual({
        state: detail.state,
        checks: detail.checks,
        observedAt: detail.observedAt,
      });
      expect(reads).toBe(0);
      yield* TestClock.adjust("16 seconds");
      yield* service.detail(reference);
      expect(yield* service.checks(reference)).toMatchObject({
        state: "closed",
        observedAt: 17_000,
      });
      expect(reads).toBe(1);
      yield* service.detail(reference);
      expect((yield* service.checks(reference))?.state).toBe("closed");
      expect(reads).toBe(1);
    }),
);
it.effect("preserves check observation time on cache hits and advances it on refresh", () =>
  Effect.gen(function* () {
    let reads = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestChecks: () =>
            Effect.sync(() => {
              reads += 1;
              return { state: "open" as const, checks: [] };
            }),
        }),
      ],
    });
    yield* TestClock.setTime(1_000);
    const first = yield* service.checks(reference);
    expect(first).toMatchObject({ observedAt: 1_000 });
    yield* TestClock.adjust("1 second");
    expect(yield* service.checks(reference)).toEqual(first);
    expect(reads).toBe(1);
    yield* TestClock.adjust("15 seconds");
    expect(yield* service.checks(reference)).toMatchObject({ observedAt: 17_000 });
    expect(reads).toBe(2);
  }),
);
it.effect("reuses an observed merged state for strict settlement reads", () =>
  Effect.gen(function* () {
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.succeed({
              ...hostedChangeRequest("merged body", 4),
              state: "merged",
              updatedAt: "2026-07-03T00:00:00Z",
            }),
          getChangeRequestSummary: () => Effect.die("strict merged state must not refresh"),
        }),
      ],
    });

    yield* service.detail(reference);

    const summary = yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual(summary.state, "merged");
    assert.strictEqual(summary.updatedAt, "2026-07-03T00:00:00Z");
  }),
);
it.effect("does not let a stale detail reopen overwrite a fresher linked summary", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let detailCalls = 0;
    let summaryTitle = "old title";
    let summaryState: "open" | "merged" = "open";
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.gen(function* () {
              detailCalls += 1;
              if (detailCalls > 1) yield* Deferred.await(gate);
              return hostedChangeRequest("old body", 4);
            }),
          getChangeRequestSummary: () =>
            Effect.succeed({
              ...changeRequest(1, "2026-07-02T00:00:00Z"),
              title: summaryTitle,
              state: summaryState,
            }),
        }),
      ],
    });

    const first = yield* service.detail(reference);
    assert.strictEqual(first.title, "Change request 1");

    summaryTitle = "merged title";
    summaryState = "merged";
    yield* TestClock.adjust("61 seconds");
    const settled = yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual(settled.title, "merged title");
    assert.strictEqual(settled.state, "merged");

    yield* TestClock.adjust("16 seconds");
    const stale = yield* service.detail(reference);
    assert.strictEqual(stale.title, "Change request 1");
    yield* Effect.yieldNow;

    const display = yield* service.summary(reference);
    assert.strictEqual(display.title, "merged title");
    assert.strictEqual(display.state, "merged");
    assert.strictEqual(detailCalls, 2);

    summaryTitle = "updated after merge";
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual((yield* service.summary(reference)).title, "merged title");
    const refreshed = yield* service.summary({ ...reference, allowStale: false });
    assert.strictEqual(refreshed.title, "updated after merge");
    assert.strictEqual(refreshed.state, "merged");
  }),
);
it.effect("keeps a row of a host that ignored the filters if any name of a label group holds", () =>
  Effect.gen(function* () {
    const sized = (number: number, updatedAt: string, ...names: ReadonlyArray<string>) => ({
      ...changeRequest(number, updatedAt),
      labels: names.map((name) => ({ name, color: null })),
    });
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                sized(1, "2026-07-04T00:00:00Z", "size:S", "bug"),
                sized(2, "2026-07-03T00:00:00Z", "size:XS", "bug"),
                sized(3, "2026-07-02T00:00:00Z", "size:L", "bug"),
                sized(4, "2026-07-01T00:00:00Z", "size:S"),
              ],
              truncated: false,
              continues: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      filters: { labels: [["size:S", "size:XS"], ["bug"]] },
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1, 2],
    );
  }),
);
it.effect.each([false, true])(
  "authorizes stack rebases and refreshes sibling layers (cross-host: %s)",
  (crossHost) =>
    Effect.gen(function* () {
      let taken = 0;
      let summaryReads = 0;
      let mutationFails = false;
      let stackRebase = true;
      let stackActions = true;
      const capabilities = {
        diff: true,
        comment: true,
        actions: ["update-branch"] as const,
        mergeMethods: ["merge"] as const,
        updateMethods: ["rebase"] as const,
        get stackActions() {
          return stackActions;
        },
        search: true,
        reactions: true,
        review: FULL_REVIEW,
        reviewers: FULL_REVIEWERS,
      };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          project({
            id: "p2",
            title: "enterprise",
            workspaceRoot: "/b",
            repository: "acme/web",
            host: "enterprise.test",
          }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities,
            getViewerPermissions: () =>
              Effect.succeed({
                actions: [],
                stackRebase,
                comment: true,
                resolve: false,
                verdicts: [],
                requestReviewers: false,
              }),
            getChangeRequestSummary: () =>
              Effect.sync(() => {
                summaryReads++;
                return changeRequest(8, "2026-07-01T00:00:00Z");
              }),
            runAction: () =>
              Effect.gen(function* () {
                taken++;
                if (mutationFails) return yield* requestFailed;
              }),
          }),
        ],
      });
      const input = {
        ...(crossHost ? { host: "enterprise.test" } : {}),
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 3,
        action: "update-branch" as const,
        updateMethod: "rebase" as const,
        stackNumber: 50,
        expectedStackHeads: [{ number: 3, headSha: "ccc" }],
      };
      yield* service.runAction(input);
      assert.strictEqual(taken, 1);
      const unrelated = { ...input, number: 8 };
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 1);
      stackRebase = false;
      assert.strictEqual(
        (yield* Effect.flip(service.runAction(input)))._tag,
        "PullRequestOperationError",
      );
      stackRebase = true;
      stackActions = false;
      assert.strictEqual(
        (yield* Effect.flip(service.runAction(input)))._tag,
        "PullRequestOperationError",
      );
      assert.strictEqual(taken, 1);
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 1);
      stackActions = true;
      mutationFails = true;
      yield* Effect.flip(service.runAction(input));
      assert.strictEqual(taken, 2);
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 2);
    }),
);
it.effect("refuses a way of updating a branch that the host or the viewer does not allow", () =>
  Effect.gen(function* () {
    let taken: string | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close", "update-branch"],
            mergeMethods: ["merge"],
            updateMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["close", "update-branch"],
              comment: true,
              resolve: true,
              verdicts: ["comment"],
              requestReviewers: false,
              updateMethods: ["merge"],
            }),
          runAction: (input) => {
            taken = input.updateMethod ?? "default";
            return Effect.void;
          },
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "update-branch", updateMethod: "rebase" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(taken, null);

    yield* service.runAction({ ...reference, action: "update-branch", updateMethod: "merge" });
    assert.strictEqual(taken, "merge");
  }),
);
it.effect("keeps reading a host's thinned-out slices until a filtered page is full", () =>
  Effect.gen(function* () {
    const reads: Array<number> = [];
    const rows = Array.from({ length: 40 }, (_, index) => ({
      ...changeRequest(index + 1, `2026-07-${String(40 - index).padStart(2, "0")}T00:00:00Z`),
      labels: index % 2 === 0 ? [{ name: "bug", color: null }] : [],
    }));
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: (input) => {
            const delivered = input.cursor?.delivered ?? 0;
            reads.push(delivered);
            return Effect.succeed({
              items: rows.slice(delivered, delivered + input.limit),
              truncated: delivered + input.limit < rows.length,
              continues: true,
            });
          },
        }),
      ],
    });

    const bugs = yield* service.list({ state: "open", limit: 4, filters: { labels: [["bug"]] } });
    assert.deepStrictEqual(
      bugs.entries.map((entry) => entry.number),
      [1, 3, 5, 7],
    );
    assert.deepStrictEqual(reads, [0, 4]);

    reads.length = 0;
    const none = yield* service.list({
      state: "open",
      limit: 4,
      filters: { labels: [["missing"]] },
    });
    assert.deepStrictEqual(none.entries, []);
    assert.strictEqual(reads.length, 5);
    assert.match(Object.values(none.nextCursors)[0] ?? "", /\|20\|/);
  }),
);
it.effect("hands a host's own resume position back on the next read", () =>
  Effect.gen(function* () {
    const resumed: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: (input) => {
            resumed.push(input.cursor?.resumeAfter);
            return Effect.succeed({
              items: [changeRequest(resumed.length, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
              resumeAfter: `2026-07-01T00:00:00.000Z~${resumed.length}`,
            });
          },
        }),
      ],
    });

    const first = yield* service.list({ state: "open", limit: 1 });
    yield* service.list({ state: "open", limit: 1, cursors: first.nextCursors });
    assert.deepStrictEqual(resumed, [undefined, "2026-07-01T00:00:00.000Z~1"]);
  }),
);
it.effect("judges the review filter only on a host that summarises its reviews", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                { ...changeRequest(1, "2026-07-02T00:00:00Z"), reviewDecision: null },
                {
                  ...changeRequest(2, "2026-07-02T00:00:00Z"),
                  reviewDecision: "approved" as const,
                },
              ],
              truncated: false,
              continues: true,
            }),
        }),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(3, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const none = yield* service.list({ state: "open", filters: { review: "none" } });
    assert.deepStrictEqual(none.entries.map((entry) => entry.number).toSorted(), [1, 3]);

    const approved = yield* service.list({ state: "open", filters: { review: "approved" } });
    assert.deepStrictEqual(approved.entries.map((entry) => entry.number).toSorted(), [2, 3]);
  }),
);
it.effect("partial host viewed writes invalidate marks but keep the diff cached", () =>
  Effect.gen(function* () {
    let diffReads = 0;
    const states = new Map<string, "viewed" | "unviewed">([
      ["a.ts", "unviewed"],
      ["b.ts", "unviewed"],
    ]);
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
            viewedFiles: "host",
          },
          getDiff: () =>
            Effect.sync(() => {
              diffReads += 1;
              return { patch: "@@", truncated: false, nextCursor: null };
            }),
          getFilesViewed: () =>
            Effect.sync(() => ({
              files: [...states].map(([path, state]) => ({ path, state })),
              truncated: false,
            })),
          setFilesViewed: () =>
            Effect.gen(function* () {
              states.set("a.ts", "viewed");
              return yield* new PullRequestProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: "setFilesViewed",
                reason: "failed",
                detail: "Second mutation refused",
              });
            }),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 10 };
    yield* service.diff(ref);
    assert.deepStrictEqual((yield* service.filesViewed(ref)).files, [
      { path: "a.ts", state: "unviewed" },
      { path: "b.ts", state: "unviewed" },
    ]);
    yield* Effect.flip(
      service.setFilesViewed({
        ...ref,
        files: [...states.keys()].map((path) => ({ path, viewed: true })),
      }),
    );
    yield* service.diff(ref);
    assert.strictEqual(diffReads, 1);
    assert.deepStrictEqual((yield* service.filesViewed(ref)).files, [
      { path: "a.ts", state: "viewed" },
      { path: "b.ts", state: "unviewed" },
    ]);
  }),
);
