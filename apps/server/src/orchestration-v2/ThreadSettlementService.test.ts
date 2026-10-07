import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ServerSettings as ContractServerSettings,
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

import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  Pick<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">;

// A fixture's user message is one the user wrote unless the test sets
// latestUserAuthoredMessageAt on its own.
function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
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
    latestUserAuthoredMessageAt: overrides.latestUserMessageAt ?? null,
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
    expect(ThreadSettlementService.isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ settledOverride: "settled" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ settledOverride: "active" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ autoSettleDisabledAt: at(-1) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ activityRunStatus: "running" }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: { kind: "approval" } as never,
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("settles a thread whose only background work is a command left running", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("keeps snoozed threads parked until they wake early on error or completion", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    // Expired snooze is no longer a park.
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, snoozedUntil: at(-1) }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(ThreadSettlementService.threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
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
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-ThreadSettlementService.QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(ThreadSettlementService.QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      ThreadSettlementService.threadHasQueuedTurnStart(
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
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-3 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 5 }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, thread: shell() }),
    ).toBeNull();
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
        mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)),
      },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-90 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleOnMerge: false }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(-3 * 60 * 60 * 1_000)) },
      }),
    ).toBeNull();
    // A thread without messages still has a stable timestamp when its PR closes.
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell(),
        pullRequest: { state: "closed", closedAt: DateTime.formatIso(at(-1)) },
        autoSettleOnMerge: false,
      }),
    ).toEqual(shell().createdAt);
  });

  it("settles on merge after agent-started runs, but not after the user writes again", () => {
    // A background command stopped after the merge and its notification
    // started a run. Only the user's own messages hold a merged thread open.
    const woken = shell({
      latestUserMessageAt: at(-30 * 60 * 1_000),
      latestUserAuthoredMessageAt: at(-2 * 60 * 60 * 1_000),
      latestRunRequestedAt: at(-30 * 60 * 1_000),
      latestRunCompletedAt: at(-29 * 60 * 1_000),
    });
    const input = {
      thread: woken,
      pullRequest: { state: "merged" as const, mergedAt: DateTime.formatIso(at(-60 * 60 * 1_000)) },
      nowMs: NOW_MS,
      autoSettleAfterDays: null,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-29 * 60 * 1_000));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: { ...woken, latestUserAuthoredMessageAt: at(-30 * 60 * 1_000) },
      }),
    ).toBeNull();
  });

  it("settles inactive threads even when their pull request remains open", () => {
    const input = {
      thread: shell({ latestUserMessageAt: at(-30 * DAY_MS) }),
      pullRequest: { state: "open" as const },
      nowMs: NOW_MS,
      autoSettleAfterDays: 2,
      autoSettleOnMerge: true,
    };
    expect(ThreadSettlementService.resolveAutoSettlementAt(input)).toEqual(at(-30 * DAY_MS));
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({ ...input, autoSettleAfterDays: null }),
    ).toBeNull();
    expect(
      ThreadSettlementService.resolveAutoSettlementAt({
        ...input,
        thread: shell({ latestUserMessageAt: at(-DAY_MS) }),
      }),
    ).toBeNull();
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");
const LINKED_PROJECT_ID = ProjectId.make("linked-settlement-project");

describe("autoSettlementSettingsKey", () => {
  it("distinguishes a project that inherits the threshold from one that disables it", () => {
    const inherits = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: true } },
    });
    const never = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
      },
    });
    assert.notStrictEqual(inherits, never);
  });

  it("ignores project overrides that do not touch settlement", () => {
    const base = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleOnMerge: false } },
    });
    const unrelated = ThreadSettlementService.autoSettlementSettingsKey({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [LINKED_PROJECT_ID]: { defaultThreadEnvMode: "worktree" },
        [PROJECT_ID]: { sidebarAutoSettleOnMerge: false, defaultAutoPull: true },
      },
    });
    assert.strictEqual(base, unrelated);
  });
});

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

function makeThread(id: string, overrides: Partial<SettlementShell> = {}): SettlementShell {
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

type SettlementSnapshot = Omit<OrchestrationV2ShellSnapshot, "threads"> & {
  readonly threads: ReadonlyArray<SettlementShell>;
};

function makeSnapshot(
  threads: ReadonlyArray<SettlementShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): SettlementSnapshot {
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

function makeBranchPullRequest(state: "open" | "closed" | "merged") {
  return {
    number: 42,
    title: "Pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "feature",
    state,
    repositoryKey: "example.test/owner/repository",
    updatedAt: NOW,
    closedAt: state === "closed" ? NOW : null,
    mergedAt: state === "merged" ? NOW : null,
  } satisfies GitManager.GitBranchPullRequest;
}

interface HarnessOptions {
  readonly snapshot: SettlementSnapshot;
  readonly settings?: ContractServerSettings;
  readonly branchPullRequest?: GitManager.GitManager["Service"]["branchPullRequest"];
  readonly pullRequestSummary?: PullRequestService.PullRequestService["Service"]["summary"];
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
  readonly onDeferredDispatch?: Effect.Effect<void>;
  /** Runs before each settle script start; a failure fails that start. */
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
  /** Runs inside each `closeIdle` call. */
  readonly onCloseIdle?: () => Effect.Effect<void>;
  /** Threads `getThread` returns when a `thread.settled` event is handled. */
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const candidateReads = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const mergedPullRequests = yield* PubSub.unbounded<PullRequestService.PullRequestMergeEvent>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const deferredCommands = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
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
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const scriptRuns =
    yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const branchPullRequest: GitManager.GitManager["Service"]["branchPullRequest"] = (input) =>
    Ref.update(branchCalls, (calls) => [...calls, input]).pipe(
      Effect.andThen(options.branchPullRequest?.(input) ?? Effect.succeed(null)),
    );
  const pullRequestSummary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
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

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type === "thread.settle-when-idle") {
      return Ref.update(deferredCommands, (recorded) => [...recorded, command.threadId]).pipe(
        Effect.andThen(options.onDeferredDispatch ?? Effect.void),
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    updateSettings,
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getSettlementCandidates: (threadId) =>
        Ref.update(candidateReads, (reads) => [...reads, threadId]).pipe(
          Effect.andThen(Ref.updateAndGet(snapshotReadCount, (count) => count + 1)),
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(Ref.get(snapshots)),
          Effect.map((snapshot) =>
            threadId === undefined
              ? snapshot.threads
              : snapshot.threads.filter((thread) => thread.id === threadId),
          ),
        ),
      getThread: (threadId) => {
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents),
      dispatch,
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: (input) =>
        Queue.offer(closedIdle, input).pipe(Effect.andThen(options.onCloseIdle?.() ?? Effect.void)),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Queue.offer(scriptRuns, input).pipe(
          Effect.andThen(options.onScriptRun?.(input) ?? Effect.void),
          Effect.as({ status: "no-script" } as const),
        ),
    }),
    Layer.mock(GitManager.GitManager)({
      branchPullRequest,
      invalidateStatus: (cwd) => Ref.update(invalidatedCwds, (cwds) => [...cwds, cwd]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      summary: pullRequestSummary,
      subscribeMerges: PubSub.subscribe(mergedPullRequests).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
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
    candidateReads,
    commands,
    deferredCommands,
    branchCalls,
    summaryCalls,
    summaryRecovery,
    invalidatedCwds,
    closedIdle,
    scriptRuns,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    updateSettings,
    publishMerge: PubSub.publish(mergedPullRequests, {
      projectId: PROJECT_ID,
      repository: "owner/repository",
      number: 42,
      mergedAt: NOW,
    }),
    layer: ThreadSettlementService.layer.pipe(Layer.provide(layerDependencies)),
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
  it.effect("settles a merged pull request stored only in the thread links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("merged-link", {
          pullRequests: [
            {
              host: "example.test",
              repository: "owner/repository",
              number: 42,
              url: "https://example.test/owner/repository/pull/42",
              source: "manual",
              linkedAt: "2026-08-20T00:00:00.000Z",
              snapshot: {
                state: "merged",
                title: "Pull request",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: NOW,
                syncedAt: NOW,
                mergedAt: NOW,
              },
              stack: null,
            },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles only the project opted in while environment settlement is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("project-opt-in", {
          latestRunCompletedAt: DateTime.makeUnsafe("2026-08-25T00:00:00.000Z"),
        });
        const other = makeThread("environment-off", { projectId: ProjectId.make("other-project") });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread, other]),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            projectSettingsOverrides: { [PROJECT_ID]: { sidebarAutoSettleAfterDays: 2 } },
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          const commands = yield* Ref.get(fixture.commands);
          expect(commands.map((command) => command.threadId)).toEqual([thread.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

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
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("open")),
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

  it.effect("skips the branch recheck when a terminal link would settle nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const previous = {
          projectId: PROJECT_ID,
          repository: "owner/repository",
          number: 1,
          url: "https://example.test/owner/repository/pull/1",
        };
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [
              makeThread("resumed-manual", {
                branch: "main",
                linkedPullRequest: previous,
                latestUserMessageAt: DateTime.makeUnsafe("2026-08-28T00:00:00.000Z"),
              }),
            ],
            [makeProject()],
          ),
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
          branchPullRequest: () => Effect.succeed(makeBranchPullRequest("open")),
          pullRequestSummary: (input) =>
            Effect.succeed({
              ...makePullRequestSummary({ ...input, state: "merged" }),
              mergedAt: "2026-08-27T00:00:00.000Z",
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
          assert.deepStrictEqual(yield* Ref.get(fixture.branchCalls), []);
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
                  ? Effect.succeed(makeBranchPullRequest("open"))
                  : Deferred.succeed(periodicLookupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releasePeriodicLookup)),
                      Effect.as(makeBranchPullRequest("open")),
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
            branchPullRequest: () => Ref.get(state).pipe(Effect.map(makeBranchPullRequest)),
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
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: true,
          },
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

describe("ThreadSettlementServiceV2 terminals", () => {
  const appThread = (
    id: string,
    settledOverride: OrchestrationV2AppThread["settledOverride"],
    worktreePath: string | null = null,
  ): OrchestrationV2AppThread => {
    const threadId = ThreadId.make(id);
    return {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: PROJECT_ID,
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      archivedAt: null,
      settledOverride,
      settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };
  const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
    type: "thread.settled",
    id: EventId.make(`event:settled:${thread.id}`),
    threadId: thread.id,
    occurredAt: DateTime.makeUnsafe(NOW),
    payload: thread,
  });

  it.effect("closes the thread's idle terminals when it settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("settled-thread", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [thread],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(thread));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: thread.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps the terminals of a thread re-engaged before the event ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaged-thread", "settled");
        const reengaged = appThread("reengaged-thread", "active");
        const marker = appThread("marker-thread", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [reengaged, marker],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          // Events run in order, so the first close belongs to the later
          // event only if the re-engaged thread was skipped.
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script in the thread's own worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = appThread("shared-checkout-thread", "settled");
        const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
        const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [shared, missing, worktree],
          existingWorktreePaths: ["/worktrees/thread"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          // Events run in order, so the first run belongs to the last event
          // only if the shared checkout and the removed worktree were skipped.
          yield* fixture.publishEvent(settledEvent(shared));
          yield* fixture.publishEvent(settledEvent(missing));
          yield* fixture.publishEvent(settledEvent(worktree));
          const run = yield* Queue.take(fixture.scriptRuns);
          assert.strictEqual(run.threadId, worktree.id);
          assert.strictEqual(run.worktreePath, "/worktrees/thread");
          assert.strictEqual(run.trigger, "settle");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips the settle script for a thread re-engaged while its shells close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settled = appThread("reengaging-thread", "settled", "/worktrees/reengaging");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const currentThreads = [settled, marker];
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads,
          existingWorktreePaths: ["/worktrees/reengaging", "/worktrees/marker"],
          // The user sends a message while the first close checks processes.
          onCloseIdle: () =>
            Effect.sync(() => {
              currentThreads[0] = { ...settled, settledOverride: "active" };
            }),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("runs the settle script once when a settlement is re-emitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repeated = appThread("repeated-thread", "settled", "/worktrees/repeated");
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [repeated, marker],
          existingWorktreePaths: ["/worktrees/repeated", "/worktrees/marker"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          // Settling an already settled thread emits the same settlement again.
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(repeated));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, repeated.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retries the settle script on a re-emitted settlement after a failed start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = appThread("failed-start-thread", "settled", "/worktrees/failed-start");
        const starts = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [thread],
          existingWorktreePaths: ["/worktrees/failed-start"],
          onScriptRun: () =>
            Ref.updateAndGet(starts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.die(new Error("terminal failed to open")) : Effect.void,
              ),
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(thread));
          yield* fixture.publishEvent(settledEvent(thread));
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, thread.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("ThreadSettlementServiceV2 single-thread sweeps", () => {
  it.effect("a finished run reads only its own thread's settlement candidate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const finished = makeThread("finished-run");
        const other = makeThread("other-thread");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([finished, other]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.candidateReads, []);
          yield* fixture.publishEvent({
            type: "provider-session.detached",
            id: EventId.make("event:detached"),
            threadId: finished.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: {
              providerSessionId: ProviderSessionId.make("provider-session:finished"),
              detachedAt: DateTime.makeUnsafe(NOW),
            },
          });
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.candidateReads), [finished.id]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("filed thread settlement", () => {
  const noAutomaticRules = {
    ...DEFAULT_SERVER_SETTINGS,
    sidebarAutoSettleAfterDays: null,
    sidebarAutoSettleOnMerge: false,
  };

  it.effect("recovers and retries a filed thread with every automatic rule disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const filedAt = DateTime.makeUnsafe(NOW);
        const attempts = yield* Ref.make(0);
        const thread = makeThread("recover-filed", {
          settleWhenIdleAt: filedAt,
          settledOverride: "active",
          autoSettleDisabledAt: filedAt,
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: noAutomaticRules,
          onDeferredDispatch: Ref.updateAndGet(attempts, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n === 1 ? Effect.die("transient dispatch failure") : Effect.void,
            ),
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.deferredCommands)).toEqual([thread.id]);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          expect(yield* Ref.get(fixture.deferredCommands)).toEqual([thread.id, thread.id]);
          expect(yield* Ref.get(fixture.commands)).toHaveLength(0);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(0);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("waits for work that wakes the agent but not for a dev server or a PR watch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const filed = { settleWhenIdleAt: DateTime.makeUnsafe(NOW) };
        const devServer = makeThread("dev-server", {
          ...filed,
          pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }],
        });
        const subagent = makeThread("subagent", {
          ...filed,
          pendingBackgroundTasks: [{ taskId: "agent", kind: "subagent" }],
        });
        // Settle stops the watch, so it must not hold the thread until the PR closes.
        const pullRequestWatch = makeThread("pull-request-watch", {
          ...filed,
          pendingBackgroundTasks: [
            { taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" },
          ],
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([devServer, subagent, pullRequestWatch]),
          settings: noAutomaticRules,
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.deferredCommands)).toEqual([
            devServer.id,
            pullRequestWatch.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});

describe("isSnoozed", () => {
  const snoozed = { snoozedAt: at(-2 * DAY_MS), snoozedUntil: at(DAY_MS) };
  it("wakes for completed work after the snooze, but not an interrupted run", () => {
    expect(ThreadSettlementService.isSnoozed(shell(snoozed), NOW_MS)).toBe(true);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, status: "interrupted", latestRunCompletedAt: at(-DAY_MS) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isSnoozed(
        shell({ ...snoozed, status: "completed", latestRunCompletedAt: at(-DAY_MS) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isSnoozed(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS),
    ).toBe(false);
  });
});
