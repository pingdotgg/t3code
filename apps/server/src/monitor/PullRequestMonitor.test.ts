import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  GitHubPullRequestMonitorDecodeError,
  type PullRequestMonitorSnapshot,
} from "../sourceControl/gitHubPullRequestMonitor.ts";
import * as MonitorRegistry from "./MonitorRegistry.ts";
import { cursorFromSnapshot } from "./monitorDiff.ts";
import { make, PullRequestSnapshotFetcher } from "./PullRequestMonitor.ts";

const threadId = ThreadId.make("monitor-thread");
const now = "2026-07-23T00:00:00.000Z";

const snapshot = (
  overrides: Partial<PullRequestMonitorSnapshot> = {},
): PullRequestMonitorSnapshot => ({
  state: "open",
  draft: false,
  headSha: "head-1",
  baseRefName: "main",
  mergeability: "mergeable",
  behindBaseBy: null,
  requiredChecksKnown: true,
  reviews: [],
  reviewThreads: [],
  issueComments: [],
  checkRuns: [
    {
      id: "ci-1",
      name: "CI",
      status: "in-progress",
      conclusion: null,
      startedAt: now,
      headSha: "head-1",
    },
  ],
  ...overrides,
});

const comment = (id: string) => ({
  id,
  author: { login: "bugbot", type: "app" as const },
  latestCommentByViewer: false,
  body: `Finding ${id}`,
  path: "src/file.ts",
  line: 12,
  createdAt: now,
  updatedAt: now,
  resolved: false,
});

const thread = (busy = false): OrchestrationThread => ({
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Monitor",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/repo",
  latestTurn: busy
    ? {
        turnId: TurnId.make("busy-turn"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      }
    : null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  monitor: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const harness = Effect.fn("PullRequestMonitor.testHarness")(function* (input: {
  readonly initial: PullRequestMonitorSnapshot;
  readonly current: { value: PullRequestMonitorSnapshot };
  readonly wakeCount?: number;
  readonly failWake?: boolean;
  readonly failEnd?: boolean;
  readonly failFreshFetch?: boolean;
  readonly reconcileFailures?: number;
  readonly reconcileThreadId?: ThreadId;
  readonly busy?: { value: boolean };
  readonly afterUpdate?: () => void;
  readonly changeGenerationAfterUpdate?: boolean;
}) {
  let registration: MonitorRegistry.MonitorRegistration | undefined = {
    threadId,
    prNumber: 42,
    generation: 1,
    startedAt: now,
    cursor: cursorFromSnapshot(input.initial),
    wakeCount: input.wakeCount ?? 0,
    repoCwd: "/repo",
  };
  const commands: OrchestrationCommand[] = [];
  const ordering: string[] = [];
  const registry = MonitorRegistry.MonitorRegistry.of({
    registerIfAbsent: (next) =>
      Effect.sync(() => {
        if (registration !== undefined) return false;
        registration = next;
        return true;
      }),
    removeGeneration: (_, generation) =>
      Effect.sync(() => {
        if (registration?.generation === generation) registration = undefined;
      }),
    get: (requestedThreadId) =>
      Effect.sync(() =>
        registration?.threadId === requestedThreadId ? Option.some(registration) : Option.none(),
      ),
    updateCursor: (_, cursor, expectedGeneration) =>
      Effect.sync(() => {
        ordering.push("ack");
        if (
          registration &&
          (expectedGeneration === undefined || registration.generation === expectedGeneration)
        ) {
          registration = { ...registration, cursor };
        }
      }),
    incrementWake: (_, expectedGeneration) =>
      Effect.sync(() => {
        if (
          registration &&
          expectedGeneration !== undefined &&
          registration.generation !== expectedGeneration
        ) {
          return registration.wakeCount;
        }
        const count = (registration?.wakeCount ?? 0) + 1;
        if (registration) registration = { ...registration, wakeCount: count };
        return count;
      }),
    setWakeCount: (_, wakeCount, expectedGeneration) =>
      Effect.sync(() => {
        if (
          registration &&
          (expectedGeneration === undefined || registration.generation === expectedGeneration)
        ) {
          registration = { ...registration, wakeCount };
        }
      }),
    remove: (_, expectedGeneration) =>
      Effect.sync(() => {
        if (
          registration &&
          expectedGeneration !== undefined &&
          registration.generation !== expectedGeneration
        ) {
          return Option.none();
        }
        const removed = registration ? Option.some(registration) : Option.none();
        registration = undefined;
        return removed;
      }),
    listActive: Effect.sync(() => (registration ? [registration] : [])),
    nextGeneration: Effect.succeed(2),
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
    dispatch: (command) => {
      commands.push(command);
      if (command.type === "thread.monitor.update") {
        input.afterUpdate?.();
        if (input.changeGenerationAfterUpdate && registration) {
          registration = { ...registration, generation: registration.generation + 1 };
        }
      }
      if (command.type === "thread.turn.start") {
        ordering.push("dispatch");
        if (input.failWake) {
          return Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "rejected",
            }),
          );
        }
      }
      if (command.type === "thread.monitor.end" && input.failEnd) {
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "rejected",
          }),
        );
      }
      return Effect.succeed({ sequence: commands.length });
    },
  });
  let fetchCount = 0;
  let reconcileCount = 0;
  const monitor = yield* make.pipe(
    Effect.provideService(MonitorRegistry.MonitorRegistry, registry),
    Effect.provideService(PullRequestSnapshotFetcher, {
      fetch: () => {
        fetchCount += 1;
        return input.failFreshFetch && fetchCount === 2
          ? Effect.fail(
              new GitHubPullRequestMonitorDecodeError({
                command: "gh",
                cwd: "/repo",
                detail: "fresh fetch failed",
                cause: null,
              }),
            )
          : Effect.succeed(input.current.value);
      },
    }),
    Effect.provideService(OrchestrationEngineService, engine),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () => {
            reconcileCount += 1;
            if (reconcileCount <= (input.reconcileFailures ?? 0)) {
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "PullRequestMonitor.test:getShellSnapshot",
                  detail: "reconcile failed",
                }),
              );
            }
            return Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: input.reconcileThreadId
                ? [
                    {
                      ...thread(),
                      id: input.reconcileThreadId,
                      monitor: {
                        status: "monitoring" as const,
                        prNumber: 42,
                        startedAt: now,
                        blockersSummary: "",
                        headSha: "head-1",
                        wakeCount: 0,
                        updatedAt: now,
                        endedAt: null,
                        endedReason: null,
                      },
                      latestUserMessageAt: null,
                      hasPendingApprovals: false,
                      hasPendingUserInput: false,
                      hasActionableProposedPlan: false,
                    },
                  ]
                : [],
              updatedAt: now,
            });
          },
          getThreadDetailById: () =>
            Effect.succeed(Option.some(thread(input.busy?.value ?? false))),
        }),
        NodeServices.layer,
      ),
    ),
  );
  return { monitor, commands, ordering, getRegistration: () => registration };
});

const endReason = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.find((command) => command.type === "thread.monitor.end");

describe("PullRequestMonitor dispatch protocol", () => {
  it.effect("terminal-discards-cycle", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ state: "merged", reviewThreads: [comment("late")] }) },
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(endReason(h.commands)?.type, "thread.monitor.end");
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
    }),
  );

  it.effect("ready-ends after a final update", () =>
    Effect.gen(function* () {
      const ready = snapshot({
        checkRuns: [{ ...snapshot().checkRuns[0]!, status: "completed", conclusion: "success" }],
      });
      const h = yield* harness({ initial: snapshot(), current: { value: ready } });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(
        h.commands.map((command) => command.type),
        ["thread.monitor.update", "thread.monitor.end"],
      );
    }),
  );

  it.effect("ignores unresolved review threads that predate monitoring", () =>
    Effect.gen(function* () {
      const oldComment = {
        ...comment("old"),
        createdAt: "2026-07-22T00:00:00.000Z",
      };
      const ready = snapshot({
        reviewThreads: [oldComment],
        checkRuns: [{ ...snapshot().checkRuns[0]!, status: "completed", conclusion: "success" }],
      });
      const h = yield* harness({ initial: snapshot(), current: { value: ready } });
      yield* h.monitor.pollOnce;
      assert.strictEqual(endReason(h.commands)?.type, "thread.monitor.end");
    }),
  );

  it.effect("wake-then-ack ordering", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
      });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(h.ordering, ["dispatch", "ack"]);
      assert.strictEqual(h.getRegistration()?.wakeCount, 1);
    }),
  );

  it.effect("failed-dispatch-preserves-cursor", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        failWake: true,
      });
      yield* h.monitor.pollOnce;
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(initial));
      assert.strictEqual(h.getRegistration()?.wakeCount, 0);
    }),
  );

  it.effect("failed-send-boundary-fetch-discards-wake-without-acking", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        failFreshFetch: true,
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(initial));
      assert.strictEqual(h.getRegistration()?.wakeCount, 0);
    }),
  );

  it.effect("provider failure correlates by dispatch time and rewinds cursor plus wake count", () =>
    Effect.gen(function* () {
      const initial = snapshot();
      const h = yield* harness({
        initial,
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
      });
      yield* h.monitor.pollOnce;
      const wake = h.commands.find((command) => command.type === "thread.turn.start");
      assert.ok(wake?.type === "thread.turn.start");
      const failureEvent = (createdAt: string) =>
        ({
          sequence: 1,
          eventId: EventId.make(`failure-${createdAt}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: CommandId.make(`failure-${createdAt}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.activity-appended",
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-${createdAt}`),
              tone: "error",
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              payload: {},
              turnId: null,
              createdAt,
            },
          },
        }) as const;
      yield* h.monitor.handleDomainEvent(failureEvent("0001-01-01T00:00:00.000Z"));
      assert.strictEqual(h.getRegistration()?.wakeCount, 1);
      yield* h.monitor.handleDomainEvent(failureEvent(wake.createdAt));
      assert.strictEqual(h.getRegistration()?.wakeCount, 0);
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(initial));
    }),
  );

  it.effect("user-turn-discards-pending-wake", () =>
    Effect.gen(function* () {
      const busy = { value: true };
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        busy,
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
      assert.deepStrictEqual(h.getRegistration()?.cursor, cursorFromSnapshot(snapshot()));
    }),
  );

  it.effect("generation-change-discards", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        changeGenerationAfterUpdate: true,
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some((command) => command.type === "thread.turn.start"),
        false,
      );
    }),
  );

  it.effect("coalesces events while a wake is in flight", () =>
    Effect.gen(function* () {
      const current = { value: snapshot({ reviewThreads: [comment("one")] }) };
      const h = yield* harness({ initial: snapshot(), current });
      yield* h.monitor.pollOnce;
      current.value = snapshot({
        reviewThreads: [comment("one"), comment("two"), comment("three")],
      });
      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
      yield* h.monitor.handleDomainEvent({
        sequence: 1,
        eventId: EventId.make("session-ready"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("session-ready"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      });
      yield* h.monitor.pollOnce;
      const wakes = h.commands.filter((command) => command.type === "thread.turn.start");
      assert.strictEqual(wakes.length, 2);
      assert.match(wakes[1]!.message.text, /Finding two/);
      assert.match(wakes[1]!.message.text, /Finding three/);
    }),
  );

  it.effect("breaker-at-10", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot({ reviewThreads: [comment("one")] }) },
        wakeCount: 10,
      });
      yield* h.monitor.pollOnce;
      const ended = endReason(h.commands);
      assert.strictEqual(ended?.type === "thread.monitor.end" && ended.reason, "needs-attention");
    }),
  );

  it.effect("archives by projecting stopped before removing the registration", () =>
    Effect.gen(function* () {
      const h = yield* harness({ initial: snapshot(), current: { value: snapshot() } });
      yield* h.monitor.handleDomainEvent({
        sequence: 1,
        eventId: EventId.make("archived"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("archived"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.archived",
        payload: { threadId, archivedAt: now, updatedAt: now },
      });
      const ended = endReason(h.commands);
      assert.strictEqual(ended?.type === "thread.monitor.end" && ended.reason, "stopped");
      assert.strictEqual(h.getRegistration(), undefined);
    }),
  );

  it.effect("removes an archived registration when projecting monitor end fails", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot() },
        failEnd: true,
      });
      yield* h.monitor.handleDomainEvent({
        sequence: 1,
        eventId: EventId.make("archived"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("archived"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.archived",
        payload: { threadId, archivedAt: now, updatedAt: now },
      });
      assert.strictEqual(h.getRegistration(), undefined);
    }),
  );

  it.effect("retries boot reconciliation on the first poll after a failed attempt", () =>
    Effect.gen(function* () {
      const orphanThreadId = ThreadId.make("orphan-monitor-thread");
      const h = yield* harness({
        initial: snapshot(),
        current: { value: snapshot() },
        reconcileFailures: 1,
        reconcileThreadId: orphanThreadId,
      });

      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some(
          (command) => command.type === "thread.monitor.end" && command.threadId === orphanThreadId,
        ),
        false,
      );

      yield* h.monitor.pollOnce;
      assert.strictEqual(
        h.commands.some(
          (command) => command.type === "thread.monitor.end" && command.threadId === orphanThreadId,
        ),
        true,
      );
    }),
  );
});
