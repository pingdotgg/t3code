import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { GitManager } from "../git/GitManager.ts";
import {
  PullRequestService,
  type PullRequestMergeEvent,
} from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "./Orchestrator.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

import {
  isAutoSettlementCandidate,
  QUEUED_TURN_START_GRACE_MS,
  resolveAutoSettlementAt,
  threadHasQueuedTurnStart,
} from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("excludes overridden, pinned, blocked, and working threads", () => {
    expect(isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ settledOverride: "settled" }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ settledOverride: "active" }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ activityRunStatus: "running" }), NOW_MS)).toBe(false);
    expect(
      isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: { kind: "approval" } as never,
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ label: "task" }] as never }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("keeps snoozed threads parked until they wake early on error or completion", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(isAutoSettlementCandidate(shell({ ...snoozed, status: "failed" }), NOW_MS)).toBe(true);
    expect(
      isAutoSettlementCandidate(
        shell({ ...snoozed, latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    // Expired snooze is no longer a park.
    expect(isAutoSettlementCandidate(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS)).toBe(
      true,
    );
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      threadHasQueuedTurnStart(
        shell({
          latestUserMessageAt: at(-1_000),
          latestRunId: "run-1" as never,
          latestRunRequestedAt: at(-500),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    // Outside the grace window the stale message no longer blocks.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("resolveAutoSettlementAt", () => {
  it("uses the latest activity time when the inactivity window elapses", () => {
    const idle = shell({
      latestUserMessageAt: at(-4 * DAY_MS),
      latestRunRequestedAt: at(-4 * DAY_MS),
      latestRunStartedAt: at(-4 * DAY_MS),
      latestRunCompletedAt: at(-3 * DAY_MS),
    });
    const input = {
      thread: idle,
      pullRequest: null,
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 5 })).toBeNull();
    expect(resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null })).toBeNull();
    expect(resolveAutoSettlementAt({ ...input, thread: shell() })).toBeNull();
  });

  it("settles on merge only after the user's last action and preserves the activity time", () => {
    const thread = shell({
      latestUserMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunCompletedAt: at(-90 * 60 * 1_000),
    });
    const input = {
      thread,
      pullRequest: {
        state: "merged" as const,
        updatedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(resolveAutoSettlementAt(input)).toEqual(at(-90 * 60 * 1_000));
    expect(resolveAutoSettlementAt({ ...input, autoSettleOnMerge: false })).toBeNull();
    expect(
      resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", updatedAt: DateTime.formatIso(at(-3 * 60 * 60 * 1_000)) },
      }),
    ).toBeNull();
    // A thread without messages still has a stable timestamp when its PR closes.
    expect(
      resolveAutoSettlementAt({
        ...input,
        thread: shell(),
        pullRequest: { state: "closed", updatedAt: DateTime.formatIso(at(-1)) },
        autoSettleOnMerge: false,
      }),
    ).toEqual(shell().createdAt);
  });

  it("settles inactive threads even when their pull request remains open", () => {
    const input = {
      thread: shell({ latestUserMessageAt: at(-30 * DAY_MS) }),
      pullRequest: { state: "open" as const, updatedAt: DateTime.formatIso(at(0)) },
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(resolveAutoSettlementAt(input)).toEqual(at(-30 * DAY_MS));
    expect(resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null })).toBeNull();
    expect(
      resolveAutoSettlementAt({
        ...input,
        thread: shell({ latestUserMessageAt: at(-DAY_MS) }),
      }),
    ).toBeNull();
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return shell({
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    ...overrides,
  });
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  };
}

function makePullRequestSummary(input: {
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt?: string;
}): PullRequestSummary {
  return {
    provider: "github",
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://example.test/${input.repository}/pull/${input.number}`,
    state: input.state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: input.updatedAt ?? NOW,
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly settings?: ServerSettings;
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const branchCalls = yield* Ref.make<
    ReadonlyArray<{ readonly cwd: string; readonly branch: string }>
  >([]);
  const summaryCalls = yield* Ref.make<
    ReadonlyArray<{
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }>
  >([]);
  const summaryRecovery = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const invalidatedCwds = yield* Ref.make<ReadonlyArray<string>>([]);

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager["Service"]["branchPullRequest"] = (input) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService["Service"]["summary"] = (input, readOptions) =>
    Effect.gen(function* () {
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      yield* Ref.update(summaryRecovery, (values) => [
        ...values,
        readOptions?.recoverTransientFailure,
      ]);
      return yield* (
        options.pullRequestSummary?.(input, readOptions) ??
          Effect.succeed(
            makePullRequestSummary({
              ...input,
              state: "open",
            }),
          )
      );
    });

  const dispatch: OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    updateSettings,
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellsWithoutEnrichment: () =>
        Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
    }),
    Layer.mock(OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.updateAndGet(snapshotReadCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
      dispatch,
    }),
    Layer.mock(GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.succeed(ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
  );

  return {
    activation,
    snapshots,
    snapshotReadCount,
    snapshotReads,
    commands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    updateSettings,
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: ThreadSettlementService.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementService.ThreadSettlementServiceV2["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("dispatches the last activity time with the v2 snapshot guard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("inactive-open-pr", {
          branch: "feature",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          branchPullRequest: () => Effect.succeed({ state: "open", updatedAt: NOW }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands).toHaveLength(1);
          expect(commands[0]?.settledAt).toEqual(thread.latestRunCompletedAt);
          expect(commands[0]?.snapshotAt).toEqual(thread.updatedAt);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates immediately after a pull request merge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const periodicLookupStarted = yield* Deferred.make<void>();
        const releasePeriodicLookup = yield* Deferred.make<void>();
        const mergedThreadSettled = yield* Deferred.make<void>();
        const branchLookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "Owner/Repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
            }),
          ]),
          branchPullRequest: () =>
            Ref.updateAndGet(branchLookupCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed({ state: "open" as const, updatedAt: NOW })
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as({ state: "open" as const, updatedAt: NOW }),
                    ),
              ),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Deferred.await(periodicLookupStarted);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergedThreadSettled);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          yield* Deferred.succeed(releasePeriodicLookup, undefined);
          yield* reactor.drain;
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "settles branch threads on a pull request merge without waiting for the next sweep",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const state = yield* Ref.make<"open" | "merged">("open");
          const mergedThreadSettled = yield* Deferred.make<void>();
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([
              makeThread("branch-thread", {
                branch: "saved-feature",
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              }),
            ]),
            branchPullRequest: () =>
              Ref.get(state).pipe(
                Effect.map((pullRequestState) => ({ state: pullRequestState, updatedAt: NOW })),
              ),
            onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), []);

            yield* Ref.set(state, "merged");
            yield* fixture.publishMerge;
            yield* Deferred.await(mergedThreadSettled);

            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              [ThreadId.make("branch-thread")],
            );
            assert.deepStrictEqual(yield* Ref.get(fixture.invalidatedCwds), ["/workspace/project"]);
            yield* reactor.drain;
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("a merge does not settle threads linked to an unrelated pull request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const mergedThreadSettled = yield* Deferred.make<void>();
        const mergeLookupStarted = yield* Deferred.make<void>();
        const releaseMergeLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("merged-in-app", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated-linked", {
              latestUserMessageAt: DateTime.makeUnsafe("2026-08-27T00:00:00.000Z"),
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 99,
                url: "https://example.test/owner/repository/pull/99",
              },
            }),
          ]),
          pullRequestSummary: (input) =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              // The initial sweep looks up both linked threads; the merge
              // sweep only looks up the unrelated one, since the merged
              // thread settles from the event itself.
              Effect.tap((count) =>
                count === 3 ? Deferred.succeed(mergeLookupStarted, undefined) : Effect.void,
              ),
              Effect.tap((count) =>
                count === 3 ? Deferred.await(releaseMergeLookup) : Effect.void,
              ),
              Effect.map(() => makePullRequestSummary({ ...input, state: "open" })),
            ),
          onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* fixture.publishMerge;
          yield* Deferred.await(mergeLookupStarted);
          yield* Deferred.await(mergedThreadSettled);
          yield* Deferred.succeed(releaseMergeLookup, undefined);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-in-app")],
          );
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.summaryCalls))
              .map((call) => call.number)
              .toSorted((left, right) => left - right),
            [42, 99, 99],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("looks up the branch pull request from a thread's live worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("live-worktree", {
                branch: "feature/live",
                worktreePath: "/workspace/project-root/.worktrees/live",
              }),
              makeThread("deleted-worktree", {
                branch: "feature/deleted",
                worktreePath: "/workspace/project-root/.worktrees/deleted",
              }),
            ],
            [makeProject(PROJECT_ID, "/workspace/project-root")],
          ),
          existingWorktreePaths: ["/workspace/project-root/.worktrees/live"],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            new Set(yield* Ref.get(fixture.branchCalls)),
            new Set([
              { cwd: "/workspace/project-root/.worktrees/live", branch: "feature/live" },
              { cwd: "/workspace/project-root", branch: "feature/deleted" },
            ]),
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
