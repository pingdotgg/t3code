import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitCooldownStore from "./UsageLimitCooldownStore.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  fallbackRestoreCommand,
  fallbackSwitchCommand,
  limitRecoveryCommand,
} from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("fallbackSwitchCommand and fallbackRestoreCommand", () => {
  const agySelection = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-4-neon",
  };
  const claudeSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
  };
  const makeProvider = (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider => ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const agyProvider = makeProvider(agySelection.instanceId, ProviderDriverKind.make("antigravity"));
  const claudeProvider = makeProvider(
    claudeSelection.instanceId,
    ProviderDriverKind.make("claudeAgent"),
  );
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    fallbackOnUsageLimit: true,
    fallbackModelSelection: claudeSelection,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      [agySelection.instanceId]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: true,
        config: {},
      },
      [claudeSelection.instanceId]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        config: {},
      },
    },
  };

  const recentAgyFailure = (resetAt: string | null, failedAgoMs = 30_000) => {
    const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
    const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
      id: ThreadId.make("thread:agy"),
      projectId: ProjectId.make("project:1"),
      modelSelection: agySelection,
      fallbackOrigin: null,
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: resetAt,
      latestRunId: RunId.make("run:agy-1"),
      latestRunCompletedAt: failedAt,
      updatedAt: failedAt,
      archivedAt: null,
      settledOverride: null,
      pendingRuntimeRequest: null,
      limitRecovery: null,
      snoozedUntil: null,
    };
    return candidate;
  };

  it("switches Antigravity Neon mid-work to Claude Code Opus 5.5 and records fallbackOrigin", () => {
    const resetAt = "2026-10-19T12:05:00.000Z";
    const cmd = fallbackSwitchCommand({
      thread: recentAgyFailure(resetAt),
      settings,
      providers: [agyProvider, claudeProvider],
      cooldowns: [],
      nowMs,
    });
    assert.isNotNull(cmd);
    assert.equal(cmd?.type, "message.dispatch");
    if (cmd?.type === "message.dispatch") {
      assert.deepEqual(cmd.modelSelection, claudeSelection);
      assert.equal(cmd.manualContinuationOfRunId, RunId.make("run:agy-1"));
      assert.deepEqual(cmd.fallbackOrigin?.originSelection, agySelection);
      assert.deepEqual(cmd.fallbackOrigin?.fallbackSelection, claudeSelection);
      assert.equal(cmd.fallbackOrigin?.resetAt, resetAt);
    }
  });

  it("also switches when resetAt is null for a recent failure", () => {
    const cmd = fallbackSwitchCommand({
      thread: recentAgyFailure(null),
      settings,
      providers: [agyProvider, claudeProvider],
      cooldowns: [],
      nowMs,
    });
    assert.equal(cmd?.type, "message.dispatch");
  });

  it("does not switch when disabled, stale, already on fallback, or reset already passed", () => {
    const resetFuture = "2026-10-19T12:05:00.000Z";
    assert.isNull(
      fallbackSwitchCommand({
        thread: recentAgyFailure(resetFuture),
        settings: { ...settings, fallbackOnUsageLimit: false },
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs,
      }),
    );
    assert.isNull(
      fallbackSwitchCommand({
        thread: recentAgyFailure(resetFuture, 11 * 60 * 1000),
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs,
      }),
    );
    assert.isNull(
      fallbackSwitchCommand({
        thread: { ...recentAgyFailure(resetFuture), modelSelection: claudeSelection },
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs,
      }),
    );
    assert.isNull(
      fallbackSwitchCommand({
        thread: recentAgyFailure("2026-10-19T11:59:59.000Z"),
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs,
      }),
    );
    // Skips if the user already manually switched the thread away from the failed run's model.
    assert.isNull(
      fallbackSwitchCommand({
        thread: {
          ...recentAgyFailure(resetFuture),
          currentModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6.1-sol",
          },
        },
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs,
      }),
    );
  });

  it("restores idle switched thread back to Antigravity Neon once resetAt passes", () => {
    const resetAt = "2026-10-19T12:05:00.000Z";
    const switchedThread: ProjectionStore.ProjectionFallbackRestoreCandidate = {
      id: ThreadId.make("thread:agy"),
      projectId: ProjectId.make("project:1"),
      modelSelection: claudeSelection,
      fallbackOrigin: {
        originSelection: agySelection,
        fallbackSelection: claudeSelection,
        switchedFromRunId: RunId.make("run:agy-1"),
        switchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        resetAt,
      },
    };
    assert.isNull(
      fallbackRestoreCommand({
        thread: switchedThread,
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs: Date.parse(resetAt) - 1,
      }),
    );
    const restore = fallbackRestoreCommand({
      thread: switchedThread,
      settings,
      providers: [agyProvider, claudeProvider],
      cooldowns: [],
      nowMs: Date.parse(resetAt),
    });
    assert.equal(restore?.type, "thread.model-selection.set");
    if (restore?.type === "thread.model-selection.set") {
      assert.deepEqual(restore.modelSelection, agySelection);
      assert.isNull(restore.fallbackOrigin);
      assert.deepEqual(restore.expectedFallbackSelection, claudeSelection);
    }
    // Manual model override by the user is never reverted.
    assert.isNull(
      fallbackRestoreCommand({
        thread: {
          ...switchedThread,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        },
        settings,
        providers: [agyProvider, claudeProvider],
        cooldowns: [],
        nowMs: Date.parse(resetAt),
      }),
    );
  });

  it.effect("worker switches to Claude Code on failure and restores Antigravity after reset", () =>
    Effect.gen(function* () {
      const startMs = Date.parse("2026-10-19T12:00:00.000Z");
      const resetMs = startMs + 60_000;
      const resetIso = DateTime.formatIso(DateTime.makeUnsafe(resetMs));
      yield* TestClock.setTime(startMs);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let switched = false;
      let restored = false;
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            UsageLimitCooldownStore.layer,
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([agyProvider, claudeProvider]),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () =>
                Effect.succeed(
                  switched
                    ? []
                    : [
                        {
                          id: ThreadId.make("thread:agy"),
                          projectId: ProjectId.make("project:1"),
                          modelSelection: agySelection,
                          fallbackOrigin: null,
                          status: "failed",
                          lastErrorClass: "usage_limit",
                          usageLimitResetAt: resetIso,
                          latestRunId: RunId.make("run:agy-1"),
                          latestRunCompletedAt: DateTime.makeUnsafe(startMs - 5_000),
                          updatedAt: DateTime.makeUnsafe(startMs - 5_000),
                          archivedAt: null,
                          settledOverride: null,
                          pendingRuntimeRequest: null,
                          limitRecovery: null,
                          snoozedUntil: null,
                        },
                      ],
                ),
              getFallbackRestoreCandidates: Effect.sync(() =>
                switched && !restored
                  ? [
                      {
                        id: ThreadId.make("thread:agy"),
                        projectId: ProjectId.make("project:1"),
                        modelSelection: claudeSelection,
                        fallbackOrigin: {
                          originSelection: agySelection,
                          fallbackSelection: claudeSelection,
                          switchedFromRunId: RunId.make("run:agy-1"),
                          switchedAt: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
                          resetAt: resetIso,
                        },
                      },
                    ]
                  : [],
              ),
              getLimitRecoveryWakeAt: (now) =>
                Effect.succeed(DateTime.toEpochMillis(now) < resetMs ? resetMs : null),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (command.type === "message.dispatch") switched = true;
                  if (command.type === "thread.model-selection.set") restored = true;
                  yield* Queue.offer(dispatched, command);
                  return { storedEvents: [] } as never;
                }),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(settings),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const first = yield* Queue.take(dispatched);
        assert.equal(first.type, "message.dispatch");
        if (first.type === "message.dispatch") {
          assert.deepEqual(first.modelSelection, claudeSelection);
        }
        yield* TestClock.adjust("60 seconds");
        const second = yield* Queue.take(dispatched);
        assert.equal(second.type, "thread.model-selection.set");
        if (second.type === "thread.model-selection.set") {
          assert.deepEqual(second.modelSelection, agySelection);
          assert.isNull(second.fallbackOrigin);
          assert.deepEqual(second.expectedFallbackSelection, claudeSelection);
        }
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "records all candidate cooldowns before deciding so an exhausted fallback is not picked in the same sweep",
    () =>
      Effect.gen(function* () {
        const startMs = Date.parse("2026-10-19T12:00:00.000Z");
        const resetIso = DateTime.formatIso(DateTime.makeUnsafe(startMs + 60_000));
        yield* TestClock.setTime(startMs);
        const dispatched: Array<OrchestrationV2ServerCommand> = [];
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const layer = UsageLimitRecoveryWorker.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Scheduler.layer,
              UsageLimitCooldownStore.layer,
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([agyProvider, claudeProvider]),
                streamChanges: Stream.never,
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getLimitRecoveryCandidates: () =>
                  Effect.succeed([
                    // Thread X failed on Antigravity Neon first in candidate order.
                    {
                      id: ThreadId.make("thread:agy-x"),
                      projectId: ProjectId.make("project:1"),
                      modelSelection: agySelection,
                      currentModelSelection: agySelection,
                      fallbackOrigin: null,
                      status: "failed",
                      lastErrorClass: "usage_limit",
                      usageLimitResetAt: resetIso,
                      latestRunId: RunId.make("run:agy-x"),
                      latestRunCompletedAt: DateTime.makeUnsafe(startMs - 5_000),
                      updatedAt: DateTime.makeUnsafe(startMs - 5_000),
                      archivedAt: null,
                      settledOverride: null,
                      pendingRuntimeRequest: null,
                      limitRecovery: null,
                      snoozedUntil: null,
                    },
                    // Thread Y failed on the configured fallback model (Claude Opus 5.5) later in the same sweep.
                    {
                      id: ThreadId.make("thread:claude-y"),
                      projectId: ProjectId.make("project:1"),
                      modelSelection: claudeSelection,
                      currentModelSelection: claudeSelection,
                      fallbackOrigin: null,
                      status: "failed",
                      lastErrorClass: "usage_limit",
                      usageLimitResetAt: resetIso,
                      latestRunId: RunId.make("run:claude-y"),
                      latestRunCompletedAt: DateTime.makeUnsafe(startMs - 4_000),
                      updatedAt: DateTime.makeUnsafe(startMs - 4_000),
                      archivedAt: null,
                      settledOverride: null,
                      pendingRuntimeRequest: null,
                      limitRecovery: null,
                      snoozedUntil: null,
                    },
                  ]),
                getFallbackRestoreCandidates: Effect.succeed([]),
                getLimitRecoveryWakeAt: () => Effect.succeed(null),
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                dispatch: (command) => {
                  dispatched.push(command);
                  return Effect.succeed({ storedEvents: [] } as never);
                },
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamDomainEvents: Stream.fromQueue(events),
              }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed(settings),
                streamChanges: Stream.never,
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* TestClock.adjust("5 seconds");
          assert.deepEqual(dispatched, []);
        }).pipe(Effect.provide(layer));
      }),
  );
});
