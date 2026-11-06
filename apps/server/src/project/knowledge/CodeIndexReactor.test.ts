import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { assert, describe, it } from "@effect/vitest";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { StorageCleanup } from "../../storageCleanup.ts";
import * as CodeIndexReactor from "./CodeIndexReactor.ts";
import * as CodeIntelligence from "./CodeIntelligence.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 86_400_000;
const PROJECT_ID = ProjectId.make("project-index-reactor");
const WORKTREE = "/worktrees/feature";
const now = DateTime.makeUnsafe(NOW_MS);

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: WORKTREE,
    branch: "feature",
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
    createdAt: at(-DAY_MS),
    updatedAt: at(-DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("worktreeIndexReleasable", () => {
  const settled = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    shell({ settledOverride: "settled", settledAt: at(-60_000), ...overrides });
  const subagent = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    shell({
      id: ThreadId.make("thread-subagent"),
      lineage: {
        rootThreadId: ThreadId.make("thread-1"),
        parentThreadId: ThreadId.make("thread-1"),
        relationshipToParent: "subagent",
      },
      ...overrides,
    });
  const unrelated = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
    shell({
      id: ThreadId.make("thread-2"),
      lineage: {
        rootThreadId: ThreadId.make("thread-2"),
        parentThreadId: null,
        relationshipToParent: null,
      },
      ...overrides,
    });

  it.each([
    { name: "one settled thread", group: () => [settled()], expected: true },
    { name: "one unsettled thread", group: () => [shell()], expected: false },
    {
      name: "a settled parent with an idle subagent",
      group: () => [settled(), subagent({ settledOverride: "settled", settledAt: at(-30_000) })],
      expected: true,
    },
    {
      name: "a settled parent with an idle subagent nobody settled",
      group: () => [settled(), subagent()],
      expected: true,
    },
    {
      name: "a settled parent with a pinned subagent",
      group: () => [settled(), subagent({ pinnedAt: now })],
      expected: false,
    },
    {
      name: "a settled parent with a side chat kept active",
      group: () => [
        settled(),
        subagent({
          settledOverride: "active",
          lineage: {
            rootThreadId: ThreadId.make("thread-1"),
            parentThreadId: ThreadId.make("thread-1"),
            relationshipToParent: null,
            sideChat: true,
          },
        }),
      ],
      expected: false,
    },
    {
      name: "a settled parent with a running subagent",
      group: () => [settled(), subagent({ status: "running", activeRunId: RunId.make("run-1") })],
      expected: false,
    },
    {
      name: "two unrelated threads, both settled",
      group: () => [settled(), unrelated({ settledOverride: "settled", settledAt: at(-90_000) })],
      expected: true,
    },
    {
      name: "two unrelated threads, one unsettled",
      group: () => [settled(), unrelated()],
      expected: false,
    },
    {
      name: "an unsettled thread unused for 7 days",
      group: () => [shell({ createdAt: at(-30 * DAY_MS), latestRunCompletedAt: at(-7 * DAY_MS) })],
      expected: true,
    },
    {
      name: "an unsettled thread unused for 6 days",
      group: () => [shell({ createdAt: at(-30 * DAY_MS), latestRunCompletedAt: at(-6 * DAY_MS) })],
      expected: false,
    },
    {
      name: "a long unused thread that is pinned",
      group: () => [shell({ createdAt: at(-30 * DAY_MS), pinnedAt: now })],
      expected: false,
    },
    {
      name: "a long unused thread kept active",
      group: () => [shell({ createdAt: at(-30 * DAY_MS), settledOverride: "active" })],
      expected: false,
    },
    {
      name: "a long unused thread with a pending request",
      group: () => [
        shell({
          createdAt: at(-30 * DAY_MS),
          pendingBackgroundTasks: [{ taskId: "task", kind: "command" }],
        }),
      ],
      expected: false,
    },
    {
      name: "a long unused thread beside a recently used one",
      group: () => [shell({ createdAt: at(-30 * DAY_MS) }), unrelated()],
      expected: false,
    },
    { name: "no threads", group: () => [], expected: false },
  ])("$name", ({ group, expected }) => {
    assert.equal(
      CodeIndexReactor.worktreeIndexReleasable(group(), NOW_MS, DEFAULT_SERVER_SETTINGS),
      expected,
    );
  });

  it.each([
    { name: "settled parent", parent: {}, child: {}, expected: true },
    { name: "active parent", parent: { settledAt: null }, child: {}, expected: false },
    { name: "running parent", parent: { status: "running" }, child: {}, expected: false },
    { name: "pinned child", parent: {}, child: { pinnedAt: now }, expected: false },
    {
      name: "explicitly active child",
      parent: {},
      child: { settledOverride: "active" },
      expected: false,
    },
    {
      name: "other project",
      parent: { projectId: ProjectId.make("other") },
      child: {},
      expected: false,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    parent: Partial<OrchestrationV2ThreadShell>;
    child: Partial<OrchestrationV2ThreadShell>;
    expected: boolean;
  }>)("handles a subagent in its own worktree with a $name", ({ parent, child, expected }) => {
    const owner = settled({ worktreePath: null, ...parent });
    const agent = subagent(child);
    assert.equal(
      CodeIndexReactor.worktreeIndexReleasable(
        [agent],
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
        new Map([owner, agent].map((thread) => [thread.id, thread])),
      ),
      expected,
    );
  });
});

function runEvent(runId: RunId, status: OrchestrationV2Run["status"]): ApplicationStoredEvent {
  return {
    sequence: 1,
    commandId: null,
    event: {
      type: "run.updated",
      occurredAt: now,
      payload: {
        id: runId,
        threadId: ThreadId.make("thread-1"),
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: "message-1",
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  } as unknown as ApplicationStoredEvent;
}

function settledEvent(thread: OrchestrationV2ThreadShell): ApplicationStoredEvent {
  return {
    sequence: 2,
    commandId: null,
    event: { type: "thread.settled", occurredAt: now, payload: thread },
  } as unknown as ApplicationStoredEvent;
}

/** A project event whose effect marks the end of the queue, proving earlier ones were skipped. */
function sentinelEvent(projectId: ProjectId): ApplicationStoredEvent {
  return {
    sequence: 3,
    eventId: EventId.make("event-sentinel"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: { projectId },
  } as unknown as ApplicationStoredEvent;
}

interface Harness {
  readonly send: (event: ApplicationStoredEvent) => Effect.Effect<void>;
  /** Effects the reactor asked for, in order. */
  readonly effects: Queue.Queue<string>;
  /** The owners the activation sweep's orphan pass rejected. */
  readonly orphansRejected: Effect.Effect<ReadonlyArray<string>>;
  /** The checkouts the activation sweep asked to clear of an older version's folders. */
  readonly legacyCheckouts: Effect.Effect<ReadonlyArray<string>>;
  /** Resolves when the next sweep starts. */
  readonly nextSweep: Effect.Effect<void>;
  readonly finishMaintenanceRun: Effect.Effect<void>;
  /** Resolves once the sweep asks whether a worktree has an index. */
  readonly indexChecked: Effect.Effect<void>;
  readonly settings: PubSub.PubSub<ServerSettings>;
  /** The next effect the reactor asks for, waiting for it if needed. */
  readonly next: Effect.Effect<string>;
  /** Sends a sentinel and returns every effect recorded before it. */
  readonly effectsBeforeSentinel: Effect.Effect<ReadonlyArray<string>>;
}

const SENTINEL = ProjectId.make("project-sentinel");
const SENTINEL_EFFECT = `ensure:${SENTINEL}`;

function reactorHarness(options: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projectRoots?: ReadonlyArray<string>;
  readonly autoCodeIndexEnabled?: boolean;
  /** Worktrees the mocked service reports an index for. */
  readonly indexed?: ReadonlyArray<string>;
  /** Checkouts the mocked orphan sweep would find an index for. */
  readonly orphanOwners?: ReadonlyArray<string>;
}): Effect.Effect<Harness, never, import("effect/Scope").Scope> {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<ApplicationStoredEvent>();
    const effects = yield* Queue.unbounded<string>();
    const orphansRejected = yield* Deferred.make<ReadonlyArray<string>>();
    const legacyCheckouts = yield* Deferred.make<ReadonlyArray<string>>();
    const sweeps = yield* Queue.unbounded<void>();
    const reports = yield* Queue.unbounded<null>();
    yield* Queue.offer(reports, null);
    const indexChecked = yield* Deferred.make<void>();
    const settings = yield* PubSub.unbounded<ServerSettings>();
    const threadsById = new Map(options.threads.map((thread) => [thread.id, thread]));
    const initial = {
      ...DEFAULT_SERVER_SETTINGS,
      autoCodeIndexEnabled: options.autoCodeIndexEnabled ?? true,
    };

    const layer = CodeIndexReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CodeIntelligence.CodeIntelligence)({
            ensureProjectIndexed: (projectId) =>
              Queue.offer(effects, `ensure:${projectId}`).pipe(Effect.asVoid),
            refreshForActiveAgent: (target) =>
              Queue.offer(effects, `refresh:${target.threadId}`).pipe(Effect.asVoid),
            removeCheckoutIndex: (checkoutPath) =>
              Queue.offer(effects, `remove:${checkoutPath}`).pipe(Effect.asVoid),
            hasCheckoutIndex: (checkoutPath) =>
              Deferred.succeed(indexChecked, undefined).pipe(
                Effect.as((options.indexed ?? []).includes(checkoutPath)),
              ),
            removeLegacyIndexes: (checkoutPaths) =>
              Deferred.succeed(legacyCheckouts, checkoutPaths).pipe(
                Effect.andThen(Queue.offer(sweeps, undefined)),
                Effect.asVoid,
              ),
            removeOrphanedIndexes: (isKnown) =>
              Deferred.succeed(
                orphansRejected,
                (options.orphanOwners ?? []).filter((owner) => !isKnown(owner)),
              ).pipe(Effect.asVoid),
            stopBuilds: Queue.offer(effects, "stop").pipe(Effect.asVoid),
          }),
          Layer.mock(StorageCleanup)({ reports: Stream.fromQueue(reports) }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestApplicationSequence: Effect.succeed(0),
            streamApplicationEvents: () => Stream.fromQueue(events),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.succeed(
                options.threads.flatMap((thread) =>
                  thread.worktreePath === null
                    ? []
                    : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
                ),
              ),
            getThreadShell: (threadId) => Effect.succeed(threadsById.get(threadId) ?? null),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed(
                (options.projectRoots ?? []).map((workspaceRoot) => ({ workspaceRoot })),
              ) as unknown as ReturnType<ProjectStore.ProjectStoreV2["Service"]["listShells"]>,
          }),
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.succeed(initial),
            subscribeChanges: PubSub.subscribe(settings).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          }),
          Path.layer,
        ),
      ),
    );
    yield* Layer.build(layer).pipe(Effect.orDie);

    const untilSentinel = (
      collected: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>> =>
      Queue.take(effects).pipe(
        Effect.flatMap((effect) =>
          effect === SENTINEL_EFFECT
            ? Effect.succeed(collected)
            : untilSentinel([...collected, effect]),
        ),
      );
    return {
      send: (event) => Queue.offer(events, event).pipe(Effect.asVoid),
      effects,
      orphansRejected: Deferred.await(orphansRejected),
      legacyCheckouts: Deferred.await(legacyCheckouts),
      nextSweep: Queue.take(sweeps),
      finishMaintenanceRun: Queue.offer(reports, null).pipe(Effect.asVoid),
      indexChecked: Deferred.await(indexChecked),
      settings,
      next: Queue.take(effects),
      // Events process in order, so the sentinel's effect proves every earlier one finished.
      effectsBeforeSentinel: Queue.offer(events, sentinelEvent(SENTINEL)).pipe(
        Effect.andThen(untilSentinel([])),
      ),
    };
  });
}

/** Records the checkouts a sweep's `known` predicate rejected, for its orphan pass. */

describe("CodeIndexReactor", () => {
  it.effect("requests an index once per run, and again for a new run", () =>
    Effect.gen(function* () {
      const harness = yield* reactorHarness({ threads: [shell()] });
      const run = RunId.make("run-1");
      yield* harness.send(runEvent(RunId.make("run-0"), "waiting"));
      // A run's status flips through `running` during approvals; each request can spawn a process.
      yield* harness.send(runEvent(run, "running"));
      yield* harness.send(runEvent(run, "waiting"));
      yield* harness.send(runEvent(run, "running"));
      yield* harness.send(runEvent(RunId.make("run-2"), "running"));
      yield* harness.send(runEvent(RunId.make("run-2"), "running"));
      yield* harness.send(runEvent(RunId.make("run-2"), "completed"));
      assert.deepEqual(yield* harness.effectsBeforeSentinel, [
        `refresh:${ThreadId.make("thread-1")}`,
        `refresh:${ThreadId.make("thread-1")}`,
      ]);
    }),
  );

  it.effect("removes a settled worktree's index", () =>
    Effect.gen(function* () {
      const thread = shell({ settledOverride: "settled", settledAt: at(-60_000) });
      const harness = yield* reactorHarness({ threads: [thread] });
      yield* harness.send(settledEvent(thread));
      assert.deepEqual(yield* harness.effectsBeforeSentinel, [`remove:${WORKTREE}`]);
    }),
  );

  it.effect("keeps a worktree's index while another thread in it is unsettled", () =>
    Effect.gen(function* () {
      const settled = shell({ settledOverride: "settled", settledAt: at(-60_000) });
      const unrelated = shell({
        id: ThreadId.make("thread-2"),
        lineage: {
          rootThreadId: ThreadId.make("thread-2"),
          parentThreadId: null,
          relationshipToParent: null,
        },
      });
      const harness = yield* reactorHarness({ threads: [settled, unrelated] });
      yield* harness.send(settledEvent(settled));
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
    }),
  );

  it.effect("keeps the index of a worktree that is a project root", () =>
    Effect.gen(function* () {
      const thread = shell({ settledOverride: "settled", settledAt: at(-60_000) });
      const harness = yield* reactorHarness({ threads: [thread], projectRoots: [WORKTREE] });
      yield* harness.send(settledEvent(thread));
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
    }),
  );

  it.effect("removes nothing when automatic indexing is off", () =>
    Effect.gen(function* () {
      const worktreePath = "/worktrees/idle";
      const thread = shell({ worktreePath, settledOverride: "settled", settledAt: at(-60_000) });
      const harness = yield* reactorHarness({
        threads: [thread],
        indexed: [worktreePath],
        autoCodeIndexEnabled: false,
      });
      yield* harness.send(settledEvent(thread));
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
      // The activation sweep is its own fiber, scheduled by the time a second round trip ends.
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
    }),
  );

  it.effect("removes orphaned indexes and old folders even while automatic indexing is off", () =>
    Effect.gen(function* () {
      const harness = yield* reactorHarness({
        threads: [shell()],
        autoCodeIndexEnabled: false,
        orphanOwners: ["/worktrees/gone", WORKTREE],
      });
      // A known worktree is kept; the deleted checkout is the only rejection.
      assert.deepEqual(yield* harness.orphansRejected, ["/worktrees/gone"]);
      assert.deepEqual(yield* harness.legacyCheckouts, [WORKTREE]);
    }),
  );

  it.effect("sweeps again whenever a Maintenance run finishes", () =>
    Effect.gen(function* () {
      const harness = yield* reactorHarness({ threads: [shell()] });
      yield* harness.nextSweep;
      yield* harness.finishMaintenanceRun;
      yield* harness.nextSweep;
    }),
  );

  it.effect("treats project roots and thread worktrees as known checkouts", () =>
    Effect.gen(function* () {
      const harness = yield* reactorHarness({
        threads: [shell()],
        projectRoots: ["/projects/one"],
        orphanOwners: ["/projects/one", WORKTREE],
      });
      assert.deepEqual(yield* harness.orphansRejected, []);
      assert.deepEqual(yield* harness.legacyCheckouts, ["/projects/one", WORKTREE]);
    }),
  );

  it.effect("does not count a deleted project as a known checkout", () =>
    Effect.gen(function* () {
      // `listShells` omits deleted projects, so its roots are absent from the known set.
      const harness = yield* reactorHarness({
        threads: [shell()],
        projectRoots: [],
        orphanOwners: ["/projects/deleted"],
      });
      assert.deepEqual(yield* harness.orphansRejected, ["/projects/deleted"]);
    }),
  );

  it.effect("keeps known Windows checkouts through drive-letter and case differences", (context) =>
    Effect.gen(function* () {
      if (!(yield* HostProcess.isWindows)) return context.skip();
      const harness = yield* reactorHarness({
        threads: [shell({ worktreePath: "c:\\worktrees\\Feature" })],
        projectRoots: ["c:\\projects\\App"],
        autoCodeIndexEnabled: false,
        orphanOwners: ["C:\\PROJECTS\\APP", "C:\\WORKTREES\\FEATURE"],
      });
      assert.deepEqual(yield* harness.orphansRejected, []);
    }),
  );

  it.effect(
    "keeps a settled Windows worktree while a differently cased thread is unsettled",
    (context) =>
      Effect.gen(function* () {
        if (!(yield* HostProcess.isWindows)) return context.skip();
        const settled = shell({
          worktreePath: "c:\\worktrees\\Feature",
          settledOverride: "settled",
          settledAt: at(-60_000),
        });
        const harness = yield* reactorHarness({
          threads: [
            settled,
            shell({ id: ThreadId.make("thread-2"), worktreePath: "C:\\WORKTREES\\FEATURE" }),
          ],
        });
        yield* harness.send(settledEvent(settled));
        assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
      }),
  );

  it.effect("stops running builds when automatic indexing is turned off", () =>
    Effect.gen(function* () {
      const harness = yield* reactorHarness({ threads: [shell()] });
      yield* PubSub.publish(harness.settings, {
        ...DEFAULT_SERVER_SETTINGS,
        autoCodeIndexEnabled: false,
      });
      assert.equal(yield* harness.next, "stop");
    }),
  );

  it.effect.each(["thread", "subagent's parent"] as const)(
    "sweeps the index of a worktree whose %s settled before this feature",
    (settledOwner) =>
      Effect.gen(function* () {
        const worktreePath = "/worktrees/settled";
        const thread = shell({
          worktreePath,
          settledOverride: "settled",
          settledAt: at(-60_000),
        });
        const threads =
          settledOwner === "thread"
            ? [thread]
            : [
                { ...thread, worktreePath: null },
                shell({
                  id: ThreadId.make("thread-subagent"),
                  worktreePath,
                  lineage: {
                    rootThreadId: thread.id,
                    parentThreadId: thread.id,
                    relationshipToParent: "subagent",
                  },
                }),
              ];
        // Activation sweeps, so the removal arrives without any event.
        const harness = yield* reactorHarness({ threads, indexed: [worktreePath] });
        assert.equal(yield* harness.next, `remove:${worktreePath}`);
      }),
  );

  it.effect("skips a settled worktree that has no index", () =>
    Effect.gen(function* () {
      const thread = shell({ settledOverride: "settled", settledAt: at(-60_000) });
      // The sweep asks the service whether an index exists, rather than checking the checkout.
      const harness = yield* reactorHarness({ threads: [thread], indexed: [] });
      yield* harness.indexChecked;
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
      // The sweep is its own fiber, scheduled by the time a second round trip ends.
      assert.deepEqual(yield* harness.effectsBeforeSentinel, []);
    }),
  );
});
