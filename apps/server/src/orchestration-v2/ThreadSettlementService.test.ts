import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import * as AutoSettlement from "./autoSettlement.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  OrchestrationV2AppThread &
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

function persistedLink(
  state: "open" | null,
  linkedAt: DateTime.Utc,
): NonNullable<SettlementShell["pullRequests"]>[number] {
  return {
    host: "example.test",
    repository: "owner/repository",
    number: 42,
    url: "https://example.test/owner/repository/pull/42",
    source: "manual",
    linkedAt: DateTime.formatIso(linkedAt),
    snapshot:
      state === null
        ? null
        : {
            state,
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: DateTime.formatIso(linkedAt),
            syncedAt: DateTime.formatIso(linkedAt),
          },
    stack: null,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("excludes settled, pinned, blocked, and working cards", () => {
    expect(AutoSettlement.isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(AutoSettlement.isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS)).toBe(
      false,
    );
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ settledOverride: "settled" }), NOW_MS),
    ).toBe(false);
    expect(AutoSettlement.isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS)).toBe(
      false,
    );
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ autoSettleDisabledAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ activityRunStatus: "running" }), NOW_MS),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: at(-DAY_MS),
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("settles a thread whose only background work is a command left running", () => {
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("keeps snoozed threads parked until a fresh failure or timer wake", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(AutoSettlement.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    // A run that completed after snoozing keeps it parked until the timer.
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "completed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    // Expired snooze is no longer a park.
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS),
    ).toBe(true);
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(AutoSettlement.threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
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
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-AutoSettlement.QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(AutoSettlement.QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("age settlement", () => {
  it.each(["queued", "preparing", "starting", "running", "waiting"] as const)(
    "keeps %s cards active even when their idle timestamps are old",
    (status) => {
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread: shell({ status }),
          nowMs: NOW_MS,
          autoSettleAfterDays: 3,
        }),
      ).toBeNull();
    },
  );

  it.each(["manual", "timer"])("restarts inactivity on a %s snooze wake", (wake) => {
    const thread = {
      ...shell({ latestRunCompletedAt: at(-4 * DAY_MS) }),
      ...(wake === "manual"
        ? { lastSnoozeWakeAt: at(-1_000) }
        : { snoozedAt: at(-3 * DAY_MS), snoozedUntil: at(-1_000) }),
    };
    const input = { thread, nowMs: NOW_MS, autoSettleAfterDays: 1 };
    expect(AutoSettlement.resolveAutoSettlementAt(input)).toBeNull();
    expect(AutoSettlement.resolveAutoSettlementAt({ ...input, nowMs: NOW_MS + DAY_MS })).toEqual(
      at(-1_000),
    );
  });

  it.each(["subagent", "background_task"] as const)(
    "keeps a completed card with a pending %s active",
    (kind) => {
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread: shell({
            status: "completed",
            latestRunCompletedAt: at(-10 * DAY_MS),
            pendingBackgroundTasks: [{ taskId: "work", kind }],
          }),
          nowMs: NOW_MS,
          autoSettleAfterDays: 3,
        }),
      ).toBeNull();
    },
  );

  it("keeps a card waiting on a watched pull request until the watch ends", () => {
    const link = {
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 7,
      url: "https://github.com/pingdotgg/t3code/pull/7",
      source: "agent" as const,
      linkedAt: "2026-06-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    };
    const watch = {
      startedAt: "2026-06-01T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passedChecks: [],
      passed: false,
      remarksThrough: "2026-06-01T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const settleAt = (pullRequests: SettlementShell["pullRequests"]) =>
      AutoSettlement.resolveAutoSettlementAt({
        thread: shell({
          status: "completed",
          latestRunCompletedAt: at(-10 * DAY_MS),
          pullRequests,
        }),
        nowMs: NOW_MS,
        autoSettleAfterDays: 3,
      });
    expect(settleAt([{ ...link, watch }])).toBeNull();
    // A dismissed stack member's leftover watch is not checked, so it holds nothing open.
    expect(settleAt([{ ...link, source: "stack-dismissed", watch }])).not.toBeNull();
    expect(settleAt([link])).not.toBeNull();
  });

  it("keeps finished cards unsettled for the full period, including the boundary", () => {
    const thread = shell({ latestRunCompletedAt: at(-3 * DAY_MS) });
    expect(
      AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS - 1, autoSettleAfterDays: 3 }),
    ).toBeNull();
    expect(
      AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS, autoSettleAfterDays: 3 }),
    ).toEqual(at(-3 * DAY_MS));
  });
  it("keeps threads with a PR from age settlement only when asked", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        linkedPullRequest: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repo",
          number: 1,
          url: "https://example.test/owner/repo/pull/1",
        },
      }),
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleKeepPullRequests: true,
    };
    expect(AutoSettlement.resolveAutoSettlementAt(input)).toBeNull();
    expect(
      AutoSettlement.resolveAutoSettlementAt({ ...input, autoSettleKeepPullRequests: false }),
    ).toEqual(at(-4 * DAY_MS));
  });
  it("settles an idle thread with an open persisted link only while retention is off", () => {
    const input = {
      thread: shell({
        latestUserMessageAt: at(-4 * DAY_MS),
        pullRequests: [persistedLink("open", at(-5 * DAY_MS))],
      }),
      nowMs: NOW_MS,
      autoSettleAfterDays: 3,
      autoSettleKeepPullRequests: false,
    };
    expect(AutoSettlement.resolveAutoSettlementAt(input)).toEqual(at(-4 * DAY_MS));
    expect(
      AutoSettlement.resolveAutoSettlementAt({ ...input, autoSettleKeepPullRequests: true }),
    ).toBeNull();
  });

  it.each([null, 0])("disables age settlement with %s", (autoSettleAfterDays) => {
    expect(
      AutoSettlement.resolveAutoSettlementAt({
        thread: shell(),
        nowMs: NOW_MS,
        autoSettleAfterDays,
      }),
    ).toBeNull();
  });
  it("restarts the clock on unsettle, visits, messages, new runs, and background completion", () => {
    for (const activity of [
      { unsettledAt: at(-DAY_MS), settledOverride: "active" as const },
      { lastVisitedAt: at(-DAY_MS) },
      { updatedAt: at(-DAY_MS) },
      { latestUserMessageAt: at(-DAY_MS) },
      { latestRunRequestedAt: at(-DAY_MS) },
      { latestRunCompletedAt: at(-DAY_MS) },
      { latestBackgroundActivityAt: at(-DAY_MS) },
    ]) {
      const thread = { ...shell(), ...activity };
      expect(
        AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS, autoSettleAfterDays: 3 }),
      ).toBeNull();
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread,
          nowMs: NOW_MS + 2 * DAY_MS,
          autoSettleAfterDays: 3,
        }),
      ).toEqual(at(-DAY_MS));
    }
  });
});

describe("finished child settlement", () => {
  const parentThreadId = ThreadId.make("parent");
  // Created and last changed long ago; only the run completion moves the clock.
  const child = (overrides: Partial<SettlementShell> = {}) =>
    shell({
      id: ThreadId.make("child"),
      parentThreadId,
      status: "completed",
      latestRunCompletedAt: at(-12 * HOUR_MS),
      ...overrides,
    });
  const settleAt = (thread: SettlementShell, afterHours = 12, nowMs = NOW_MS) =>
    AutoSettlement.resolveFinishedChildSettlementAt({ thread, nowMs, afterHours });

  it("settles a child done for the full period, including the boundary", () => {
    expect(settleAt(child(), 12, NOW_MS - 1)).toBeNull();
    expect(settleAt(child())).toEqual(at(-12 * HOUR_MS));
    expect(settleAt(child({ status: "idle", latestRunCompletedAt: null }))).toEqual(
      at(-10 * DAY_MS),
    );
  });

  it("applies only to threads with a parent", () => {
    expect(settleAt(child({ parentThreadId: null }))).toBeNull();
  });

  it.each([
    "queued",
    "preparing",
    "starting",
    "running",
    "waiting",
    "failed",
    "interrupted",
  ] as const)("never settles a %s child", (status) => {
    expect(settleAt(child({ status }))).toBeNull();
  });

  it("never settles a child that needs input or that its parent keeps", () => {
    expect(
      settleAt(
        child({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: at(-DAY_MS),
          },
        }),
      ),
    ).toBeNull();
    expect(settleAt(child({ autoSettleDisabledAt: at(-DAY_MS) }))).toBeNull();
    expect(settleAt(child({ pinnedAt: at(-DAY_MS) }))).toBeNull();
    expect(
      settleAt(child({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] })),
    ).toBeNull();
  });

  it("is off at 0 hours", () => {
    expect(settleAt(child(), 0)).toBeNull();
  });

  it("restarts the clock on any change to the child", () => {
    for (const activity of [
      { updatedAt: at(-HOUR_MS) },
      { latestUserMessageAt: at(-HOUR_MS) },
      { latestRunRequestedAt: at(-HOUR_MS) },
      { latestRunCompletedAt: at(-HOUR_MS) },
      { unsettledAt: at(-HOUR_MS), settledOverride: "active" as const },
    ]) {
      const thread = child(activity);
      expect(settleAt(thread)).toBeNull();
      expect(settleAt(thread, 12, NOW_MS + 11 * HOUR_MS)).toEqual(at(-HOUR_MS));
    }
  });
});

const makeHarness = Effect.fn(function* (input: {
  threads: ReadonlyArray<SettlementShell>;
  settings?: ContractServerSettings;
  activeDescendants?: ReadonlySet<string>;
  existingWorktreePaths?: ReadonlyArray<string>;
}) {
  const candidates = yield* Ref.make(input.threads);
  const reads = yield* Queue.unbounded<ThreadId | undefined>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const closedIdle = yield* Queue.unbounded<string>();
  const scriptRuns =
    yield* Queue.unbounded<
      Parameters<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]>[0]
    >();
  const activation = yield* Deferred.make<void>();
  const settings = yield* Ref.make(input.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* Queue.unbounded<ContractServerSettings>();
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getSettlementCandidates: (id) =>
        Ref.get(candidates).pipe(
          Effect.map((all) => (id === undefined ? all : all.filter((thread) => thread.id === id))),
          Effect.tap(() => Queue.offer(reads, id)),
        ),
      getAutoArchiveCandidates: ({ settledBefore, limit }) =>
        Ref.get(candidates).pipe(
          Effect.map((all) =>
            all
              .filter(
                (thread) =>
                  thread.settledOverride === "settled" &&
                  thread.settledAt !== null &&
                  DateTime.toEpochMillis(thread.settledAt) <= DateTime.toEpochMillis(settledBefore),
              )
              .slice(0, limit),
          ),
        ),
      hasActiveDescendants: (id) => Effect.succeed(input.activeDescendants?.has(id) ?? false),
      getThread: (id) =>
        Ref.get(candidates).pipe(
          Effect.map((all) => {
            const thread = all.find((thread) => thread.id === id)!;
            return { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null };
          }),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(settings),
      subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: ({ threadId }) =>
        Queue.offer(closedIdle, ThreadId.make(threadId)).pipe(Effect.asVoid),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (runInput) =>
        Queue.offer(scriptRuns, runInput).pipe(Effect.as({ status: "no-script" } as const)),
    }),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(input.existingWorktreePaths?.includes(path) ?? false),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  return {
    candidates,
    reads,
    events,
    commands,
    closedIdle,
    scriptRuns,
    layer: ThreadSettlementService.layer.pipe(Layer.provide(layerDependencies)),
    start: (service: ThreadSettlementService.ThreadSettlementServiceV2["Service"]) =>
      Effect.gen(function* () {
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(reads);
        yield* service.drain;
      }),
  };
});

it.effect("sweeps on the fake clock with project overrides and active descendants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const enabled = ProjectId.make("enabled");
      const disabled = ProjectId.make("disabled");
      const fixture = yield* makeHarness({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleAfterDays: 3,
          projectSettingsOverrides: { [disabled]: { sidebarAutoSettleAfterDays: 0 } },
        },
        activeDescendants: new Set(["busy-parent"]),
        threads: [
          shell({
            id: ThreadId.make("recent"),
            projectId: enabled,
            latestRunCompletedAt: at(-3 * DAY_MS + 60_000),
          }),
          shell({ id: ThreadId.make("old"), projectId: enabled }),
          shell({ id: ThreadId.make("busy-parent"), projectId: enabled }),
          shell({ id: ThreadId.make("disabled"), projectId: disabled }),
          shell({
            id: ThreadId.make("monitor"),
            projectId: enabled,
            pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
          }),
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        const first = yield* Ref.get(fixture.commands);
        assert.deepEqual(
          first.map((command) => ("threadId" in command ? command.threadId : null)),
          [ThreadId.make("old")],
        );
        assert.equal(first[0]?.type, "thread.auto-settle");
        yield* Ref.update(fixture.candidates, (all) => all.filter((thread) => thread.id !== "old"));
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        const recent = (yield* Ref.get(fixture.commands)).find(
          (command) => "threadId" in command && command.threadId === "recent",
        );
        assert.isDefined(recent);
        if (recent?.type === "thread.auto-settle") {
          assert.deepEqual(recent.snapshotAt, at(-10 * DAY_MS));
          assert.deepEqual(recent.settledAt, at(-3 * DAY_MS + 60_000));
          assert.match(recent.commandId, /^server:auto-settle:recent:/);
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("settles an old child chat by its own age and leaves its recent parent untouched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const parent = ThreadId.make("parent");
      const fixture = yield* makeHarness({
        threads: [
          shell({ id: parent, latestUserMessageAt: at(-DAY_MS) }),
          shell({
            id: ThreadId.make("child"),
            lineage: {
              rootThreadId: parent,
              parentThreadId: parent,
              relationshipToParent: "fork",
            },
          }),
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        assert.deepEqual(
          (yield* Ref.get(fixture.commands)).map((command) =>
            "threadId" in command ? command.threadId : null,
          ),
          [ThreadId.make("child")],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("provider detachment requests a single-card sweep without settling a recent card", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const thread = shell({ id: ThreadId.make("finished"), latestRunCompletedAt: at(0) });
      const fixture = yield* makeHarness({ threads: [thread] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        yield* Queue.offer(fixture.events, {
          type: "provider-session.detached",
          id: EventId.make("detached"),
          threadId: thread.id,
          occurredAt: at(0),
          payload: {
            providerSessionId: ProviderSessionId.make("finished-session"),
            detachedAt: at(0),
          },
        });
        assert.equal(yield* Queue.take(fixture.reads), thread.id);
        yield* service.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("keeps terminals when a settled card was re-engaged before the event was handled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const resumed = shell({
        id: ThreadId.make("resumed"),
        settledOverride: "active",
        unsettledAt: at(0),
      });
      const marker = shell({
        id: ThreadId.make("marker"),
        settledOverride: "settled",
        settledAt: at(0),
      });
      const fixture = yield* makeHarness({ threads: [resumed, marker] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        for (const thread of [resumed, marker]) {
          yield* Queue.offer(fixture.events, {
            type: "thread.settled",
            id: EventId.make(`settled:${thread.id}`),
            threadId: thread.id,
            occurredAt: at(0),
            payload: {
              ...thread,
              lastVisitedAt: thread.lastVisitedAt ?? null,
              settledOverride: "settled",
              settledAt: at(0),
            },
          });
        }
        // The stream handles events in order; only the later card should close.
        assert.equal(yield* Queue.take(fixture.closedIdle), marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("runs the settle script once per settlement, only in the thread's own worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const settled = { settledOverride: "settled" as const, settledAt: at(0) };
      const shared = shell({ id: ThreadId.make("shared"), ...settled });
      const removed = shell({ id: ThreadId.make("removed"), ...settled, worktreePath: "/wt/gone" });
      const worktree = shell({
        id: ThreadId.make("worktree"),
        ...settled,
        worktreePath: "/wt/live",
      });
      const marker = shell({ id: ThreadId.make("marker"), ...settled, worktreePath: "/wt/marker" });
      const fixture = yield* makeHarness({
        threads: [shared, removed, worktree, marker],
        existingWorktreePaths: ["/wt/live", "/wt/marker"],
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        // Settling a settled thread re-emits the same settlement; it runs once.
        for (const thread of [shared, removed, worktree, worktree, marker]) {
          yield* Queue.offer(fixture.events, {
            type: "thread.settled",
            id: EventId.make(`settled:${thread.id}`),
            threadId: thread.id,
            occurredAt: at(0),
            payload: { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null },
          });
        }
        // Events run in order, so the marker's run comes next only if the shared
        // checkout, the removed worktree, and the repeat were all skipped.
        const run = yield* Queue.take(fixture.scriptRuns);
        assert.equal(run.threadId, worktree.id);
        assert.equal(run.worktreePath, "/wt/live");
        assert.equal(run.trigger, "settle");
        assert.equal((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("an unsettled card gets a full new idle period on the sweep clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const thread = shell({ settledOverride: "active", unsettledAt: at(0) });
      const fixture = yield* makeHarness({ threads: [thread] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        yield* TestClock.adjust(3 * DAY_MS - 60_000);
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        const commands = yield* Ref.get(fixture.commands);
        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.type, "thread.auto-settle");
        if (commands[0]?.type === "thread.auto-settle") {
          assert.deepEqual(commands[0].settledAt, at(0));
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

describe("finished child sweep", () => {
  const parent = ThreadId.make("parent");
  const child = (id: string, overrides: Partial<SettlementShell> = {}) =>
    shell({
      id: ThreadId.make(id),
      parentThreadId: parent,
      status: "completed",
      latestRunCompletedAt: at(-12 * HOUR_MS),
      ...overrides,
    });
  const settledIds = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
    commands.map((command) => ("threadId" in command ? command.threadId : null));

  it.effect("settles children done for 12 hours by default and leaves their parent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          threads: [
            shell({ id: parent, status: "completed", latestRunCompletedAt: at(-13 * HOUR_MS) }),
            child("done"),
            child("recent", { latestRunCompletedAt: at(-11 * HOUR_MS) }),
            child("running", { status: "running" }),
            child("asking", {
              pendingRuntimeRequest: {
                id: RuntimeRequestId.make("question"),
                kind: "user_input",
                createdAt: at(-DAY_MS),
              },
            }),
            child("kept", { autoSettleDisabledAt: at(-DAY_MS) }),
            child("busy-descendants"),
          ],
          activeDescendants: new Set(["busy-descendants"]),
        });
        yield* Effect.gen(function* () {
          yield* fixture.start(yield* ThreadSettlementService.ThreadSettlementServiceV2);
          const commands = yield* Ref.get(fixture.commands);
          assert.deepEqual(settledIds(commands), [ThreadId.make("done")]);
          const [command] = commands;
          assert.equal(command?.type, "thread.auto-settle");
          if (command?.type === "thread.auto-settle") {
            assert.equal(command.reason, "finished-child");
            assert.deepEqual(command.settledAt, at(-12 * HOUR_MS));
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("activity at 11 hours restarts the 12 hour clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          threads: [child("child", { latestRunCompletedAt: at(-11 * HOUR_MS) })],
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* fixture.start(service);
          // A new message lands 11 hours after the child finished.
          yield* Ref.update(fixture.candidates, (all) =>
            all.map((thread) => ({ ...thread, latestUserMessageAt: at(0) })),
          );
          yield* TestClock.adjust(12 * HOUR_MS - 60_000);
          yield* Queue.take(fixture.reads);
          yield* service.drain;
          assert.deepEqual(yield* Ref.get(fixture.commands), []);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.reads);
          yield* service.drain;
          const commands = yield* Ref.get(fixture.commands);
          assert.deepEqual(settledIds(commands), [ThreadId.make("child")]);
          if (commands[0]?.type === "thread.auto-settle") {
            assert.deepEqual(commands[0].settledAt, at(0));
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("the setting at 0 leaves children to the age rule", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          settings: { ...DEFAULT_SERVER_SETTINGS, autoSettleFinishedChildrenAfterHours: 0 },
          threads: [child("child", { latestRunCompletedAt: at(-2 * DAY_MS) })],
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* fixture.start(service);
          assert.deepEqual(yield* Ref.get(fixture.commands), []);
          yield* TestClock.adjust(DAY_MS);
          yield* Queue.take(fixture.reads);
          yield* service.drain;
          const [command] = yield* Ref.get(fixture.commands);
          assert.equal(command?.type, "thread.auto-settle");
          if (command?.type === "thread.auto-settle") assert.isUndefined(command.reason);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a restart recomputes the pending deadline from persisted activity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const threads = [child("child", { latestRunCompletedAt: at(-6 * HOUR_MS) })];
      const run = Effect.fn(function* () {
        const fixture = yield* makeHarness({ threads });
        return yield* Effect.gen(function* () {
          yield* fixture.start(yield* ThreadSettlementService.ThreadSettlementServiceV2);
          return yield* Ref.get(fixture.commands);
        }).pipe(Effect.provide(fixture.layer));
      });
      assert.deepEqual(yield* Effect.scoped(run()), []);
      // The server is down past the deadline; the first sweep after start settles at once.
      yield* TestClock.adjust(7 * HOUR_MS);
      const commands = yield* Effect.scoped(run());
      assert.deepEqual(settledIds(commands), [ThreadId.make("child")]);
      if (commands[0]?.type === "thread.auto-settle") {
        assert.deepEqual(commands[0].settledAt, at(-6 * HOUR_MS));
      }
    }),
  );
});

describe("auto-archive", () => {
  const settled = (id: string, settledDaysAgo: number, overrides: Partial<SettlementShell> = {}) =>
    shell({
      id: ThreadId.make(id),
      settledOverride: "settled",
      settledAt: at(-settledDaysAgo * DAY_MS),
      updatedAt: at(-settledDaysAgo * DAY_MS),
      ...overrides,
    });
  const due = (thread: SettlementShell, afterDays = 10) =>
    AutoSettlement.isAutoArchiveDue(thread, { nowMs: NOW_MS, afterDays });
  const archivedIds = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
    commands.flatMap((command) =>
      command.type === "thread.auto-archive" ? [command.threadId] : [],
    );

  it("archives after the full settled period, including the boundary", () => {
    expect(due(settled("a", 10))).toBe(true);
    expect(due(settled("a", 10 - 1 / 24))).toBe(false);
    expect(due(settled("a", 4), 3)).toBe(true);
    expect(due(settled("a", 400), 0)).toBe(false);
    expect(due(shell({ settledAt: at(-30 * DAY_MS) }))).toBe(false);
    expect(due(settled("a", 30, { archivedAt: at(-DAY_MS) }))).toBe(false);
  });

  it("keeps anything still waiting on the thread or the user", () => {
    const old = (overrides: Partial<SettlementShell>) => due(settled("a", 30, overrides));
    expect(old({ pinnedAt: at(-DAY_MS) })).toBe(false);
    expect(old({ autoSettleDisabledAt: at(-DAY_MS) })).toBe(false);
    expect(old({ snoozedUntil: at(DAY_MS), snoozedAt: at(-DAY_MS) })).toBe(false);
    expect(old({ activityRunStatus: "running" })).toBe(false);
    expect(old({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] })).toBe(false);
    expect(
      old({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("question"),
          kind: "user_input",
          createdAt: at(-DAY_MS),
        },
      }),
    ).toBe(false);
    expect(old({ pullRequests: [persistedLink("open", at(-30 * DAY_MS))] })).toBe(false);
    expect(
      old({
        pullRequests: [
          {
            ...persistedLink(null, at(-30 * DAY_MS)),
            watch: {
              startedAt: DateTime.formatIso(at(-30 * DAY_MS)),
              headSha: null,
              failedChecks: [],
              passedChecks: [],
              passed: false,
              remarksThrough: DateTime.formatIso(at(-30 * DAY_MS)),
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
        ],
      }),
    ).toBe(false);
    expect(old({ pullRequests: [persistedLink(null, at(-30 * DAY_MS))] })).toBe(true);
  });

  it.effect.each([
    ["the default 10 days", undefined, ["old"]],
    ["3 days", 3, ["old", "week"]],
    ["0 (off)", 0, []],
  ] as const)("sweeps with %s", ([, afterDays, expected]) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* makeHarness({
          settings:
            afterDays === undefined
              ? DEFAULT_SERVER_SETTINGS
              : { ...DEFAULT_SERVER_SETTINGS, autoArchiveSettledAfterDays: afterDays },
          activeDescendants: new Set(["busy-parent"]),
          threads: [
            settled("old", 11),
            settled("week", 7),
            settled("busy-parent", 30),
            settled("pinned", 30, { pinnedAt: at(-DAY_MS) }),
          ],
        });
        yield* Effect.gen(function* () {
          yield* fixture.start(yield* ThreadSettlementService.ThreadSettlementServiceV2);
          const commands = yield* Ref.get(fixture.commands);
          assert.deepEqual(archivedIds(commands), expected.map(ThreadId.make));
          const [first] = commands;
          if (first?.type === "thread.auto-archive") {
            assert.deepEqual(first.snapshotAt, at(-11 * DAY_MS));
            assert.match(first.commandId, /^server:auto-archive:old:/);
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
