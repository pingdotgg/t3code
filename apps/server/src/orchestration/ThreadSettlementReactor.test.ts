import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type PullRequestSummary,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
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
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadSettlementReactor from "./ThreadSettlementReactor.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

type AutoSettleCommand = Extract<OrchestrationCommand, { readonly type: "thread.auto-settle" }>;

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
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads,
    updatedAt: NOW,
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
    closedAt: input.state === "closed" ? (input.updatedAt ?? NOW) : null,
    mergedAt: input.state === "merged" ? (input.updatedAt ?? NOW) : null,
  };
}

interface HarnessOptions {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly settings?: ServerSettings;
  readonly branchPullRequest?: GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (
    command: AutoSettleCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
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

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
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
      getShellSnapshot: () =>
        Ref.updateAndGet(snapshotReadCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
        ),
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
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
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
    layer: ThreadSettlementReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementReactor.ThreadSettlementReactor["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

describe("ThreadSettlementReactor", () => {
  it.effect("starts without clients and skips protected threads before pull request lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        } as const;
        const skipped = [
          makeThread("pending-approval", {
            branch: "skip-approval",
            hasPendingApprovals: true,
          }),
          makeThread("snoozed", {
            branch: "skip-snoozed",
            snoozedUntil: "2026-08-29T00:00:00.000Z",
          }),
        ];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("inactive", { branch: "inactive-feature" }),
              makeThread("closed-pr", { linkedPullRequest }),
              ...skipped,
            ],
            [makeProject(), makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          branchPullRequest: () => Effect.succeed(null),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "closed" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 0);

          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands
              .map(({ threadId, snapshotSequence, settledAt }) => ({
                threadId,
                snapshotSequence,
                settledAt,
              }))
              .sort((left, right) => left.threadId.localeCompare(right.threadId)),
            [
              {
                threadId: ThreadId.make("closed-pr"),
                snapshotSequence: 1,
                settledAt: "2026-08-20T00:00:00.000Z",
              },
              {
                threadId: ThreadId.make("inactive"),
                snapshotSequence: 1,
                settledAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          );
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), [
            { cwd: "/workspace/project", branch: "inactive-feature" },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 42 },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryRecovery), [false]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("reevaluates inactivity and pull request state once per minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const pullRequest = yield* Ref.make<"open" | "merged">("open");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("at-boundary", {
              latestUserMessageAt: "2026-08-25T12:00:00.000Z",
            }),
            makeThread("open-pr", {
              branch: "saved-feature",
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
            }),
          ]),
          branchPullRequest: () =>
            Ref.get(pullRequest).pipe(
              Effect.map((state) => ({ state, updatedAt: NOW, closedAt: NOW, mergedAt: NOW })),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* Ref.set(pullRequest, "merged");
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands))
              .map((command) => command.threadId)
              .sort((left, right) => left.localeCompare(right)),
            [ThreadId.make("at-boundary"), ThreadId.make("open-pr")],
          );
          assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, 2);
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
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("slow-periodic-lookup", {
              branch: "another-feature",
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
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
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
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
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              }),
            ]),
            branchPullRequest: () =>
              Ref.get(state).pipe(
                Effect.map((pullRequestState) => ({
                  state: pullRequestState,
                  updatedAt: NOW,
                  closedAt: NOW,
                  mergedAt: NOW,
                })),
              ),
            onDispatch: () => Deferred.succeed(mergedThreadSettled, undefined),
          });

          yield* Effect.gen(function* () {
            const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
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
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
              linkedPullRequest: {
                projectId: PROJECT_ID,
                repository: "owner/repository",
                number: 42,
                url: "https://example.test/owner/repository/pull/42",
              },
            }),
            makeThread("unrelated-linked", {
              latestUserMessageAt: "2026-08-27T00:00:00.000Z",
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
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
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

  it.effect("uses fresh settlement settings after lookup and ignores unrelated changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const state = yield* Ref.make<"merged" | "closed">("merged");
        const firstLookupStarted = yield* Deferred.make<void>();
        const releaseFirstLookup = yield* Deferred.make<void>();
        const laterLookupStarted = yield* Deferred.make<void>();
        const releaseLaterLookup = yield* Deferred.make<void>();
        const lookupCount = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("settings-thread", { branch: "saved-feature" })]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: () =>
            Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 1
                  ? Deferred.succeed(firstLookupStarted, undefined)
                  : count === 3
                    ? Deferred.succeed(laterLookupStarted, undefined)
                    : Effect.void,
              ),
              Effect.tap((count) =>
                count === 1
                  ? Deferred.await(releaseFirstLookup)
                  : count === 3
                    ? Deferred.await(releaseLaterLookup)
                    : Effect.void,
              ),
              Effect.andThen(Ref.get(state)),
              Effect.map((pullRequestState) => ({
                state: pullRequestState,
                updatedAt: NOW,
                closedAt: NOW,
                mergedAt: NOW,
              })),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* Deferred.await(firstLookupStarted);

          yield* fixture.updateSettings({ sidebarAutoSettleOnMerge: false });
          yield* Deferred.succeed(releaseFirstLookup, undefined);
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 2);

          yield* Ref.set(state, "closed");
          yield* fixture.updateSettings({ enableAgentBrowserAccess: false });
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
          yield* Deferred.await(laterLookupStarted);
          yield* Deferred.succeed(releaseLaterLookup, undefined);
          yield* reactor.drain;

          assert.strictEqual(yield* Ref.get(fixture.snapshotReadCount), 3);
          assert.strictEqual(yield* Ref.get(lookupCount), 3);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("settings-thread")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps an unknown pull request active and continues with other candidates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("lookup-failed", {
                linkedPullRequest: {
                  projectId: LINKED_PROJECT_ID,
                  repository: "owner/repository",
                  number: 9,
                  url: "https://example.test/owner/repository/pull/9",
                },
              }),
              makeThread("inactive-without-pr"),
            ],
            [makeProject(), makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          pullRequestSummary: () =>
            Effect.fail(
              new PullRequestOperationError({
                operation: "summary",
                detail: "host unavailable",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("inactive-without-pr")],
          );
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps threads active when their pull request project is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 10,
          url: "https://example.test/owner/repository/pull/10",
        } as const;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("missing-own-project", {
                latestUserMessageAt: "2026-08-27T00:00:00.000Z",
                linkedPullRequest,
              }),
              makeThread("missing-branch-project", { branch: "saved-feature" }),
            ],
            [makeProject(LINKED_PROJECT_ID, "/workspace/linked")],
          ),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "open" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 10 },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("deduplicates saved-branch and linked pull request lookups within a sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const linkedPullRequest = {
          projectId: LINKED_PROJECT_ID,
          repository: "owner/repository",
          number: 77,
          url: "https://example.test/owner/repository/pull/77",
        } as const;
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("branch-one", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-one",
              }),
              makeThread("branch-two", {
                branch: "saved-feature",
                worktreePath: "/deleted/worktree-two",
              }),
              makeThread("linked-one", { linkedPullRequest }),
              makeThread("linked-two", { linkedPullRequest }),
            ],
            [
              makeProject(PROJECT_ID, "/workspace/project-root"),
              makeProject(LINKED_PROJECT_ID, "/workspace/linked-root"),
            ],
          ),
          branchPullRequest: () =>
            Effect.succeed({ state: "closed", updatedAt: NOW, closedAt: NOW }),
          pullRequestSummary: (input) =>
            Effect.succeed(makePullRequestSummary({ ...input, state: "merged" })),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), [
            { cwd: "/workspace/project-root", branch: "saved-feature" },
          ]);
          assert.deepStrictEqual(yield* Ref.get(fixture.summaryCalls), [
            { projectId: LINKED_PROJECT_ID, repository: "owner/repository", number: 77 },
          ]);
          assert.deepStrictEqual(
            new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
            new Set([
              ThreadId.make("branch-one"),
              ThreadId.make("branch-two"),
              ThreadId.make("linked-one"),
              ThreadId.make("linked-two"),
            ]),
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
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
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

  it.effect("carries the snapshot guard and survives a stale dispatch rejection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("stale"), makeThread("next-candidate")]),
          onDispatch: (command) =>
            command.threadId === ThreadId.make("stale")
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "thread changed after settlement evaluation",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);

          const firstSweep = yield* Ref.get(fixture.commands);
          assert.strictEqual(
            firstSweep.find((command) => command.threadId === ThreadId.make("stale"))
              ?.snapshotSequence,
            1,
          );
          assert.strictEqual(
            firstSweep.some((command) => command.threadId === ThreadId.make("next-candidate")),
            true,
          );

          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 4 });
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 4);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
