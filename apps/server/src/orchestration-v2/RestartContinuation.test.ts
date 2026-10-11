import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
// "No project" threads belong to the environment's Scratch project.
const scratchProjectId = ProjectId.make("project:scratch");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("requires matching saved native state for an unfinished root run", () => {
  const projection = makeProjection();
  assert.equal(restartContinuationRun(projection)?.id, runId);
  for (const invalid of [
    { ...projection, thread: { ...projection.thread, archivedAt: {} } },
    { ...projection, thread: { ...projection.thread, deletedAt: {} } },
    {
      ...projection,
      thread: { ...projection.thread, providerInstanceId: ProviderInstanceId.make("other") },
    },
    {
      ...projection,
      providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
    },
    {
      ...projection,
      providerSessions: [
        {
          ...projection.providerSessions[0]!,
          providerInstanceId: ProviderInstanceId.make("other"),
        },
      ],
    },
    { ...projection, providerTurns: [] },
    ...[
      "queued",
      "preparing",
      "starting",
      "waiting",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ].map((status) => ({ ...projection, runs: [{ ...projection.runs[0]!, status }] })),
  ])
    assert.isUndefined(restartContinuationRun(invalid as OrchestrationV2ThreadProjection));
});

it.effect.each([
  ["user_input", "pending", "live", false],
  ["user_input", "expired", "not_resumable", false],
  ["user_input", "cancelled", "not_resumable", false],
  ["command", "pending", "live", false],
  ["command", "expired", "not_resumable", false],
  ["command", "cancelled", "not_resumable", false],
  ["user_input", "resolved", "live", true],
  ["command", "cancelled", "live", true],
  ["user_input", "pending", "message", true],
  ["dynamic_tool_call", "pending", "live", true],
  ["auth_refresh", "pending", "live", true],
] as const)(
  "respects a %s request that is %s with %s response capability across restart",
  ([kind, status, capability, shouldContinue]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request:restart"),
            nodeId: NodeId.make("node:restart-question"),
            providerTurnId: base.providerTurns[0]!.id,
            kind,
            status,
            responseCapability:
              capability === "live"
                ? { type: capability, providerSessionId: sessionId }
                : capability === "not_resumable"
                  ? {
                      type: capability,
                      reason: "The server restarted before this runtime request was resolved.",
                    }
                  : { type: capability },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(projection) !== undefined, shouldContinue);
      const dispatch = [] as Array<unknown>;
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "cancelled" as const }],
                }),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                dispatch.push(command);
                return Effect.succeed({} as never);
              },
            }),
          ),
        ),
      );
      assert.lengthOf(dispatch, shouldContinue ? 1 : 0);
    }),
);

it("continues a live turn whose session the adapter never marked running", () => {
  const projection = makeProjection();
  // Codex, Claude, Cursor and ACP sessions stay "ready" for their whole life.
  const withSessionStatus = (status: string) =>
    ({
      ...projection,
      providerSessions: [{ ...projection.providerSessions[0]!, status }],
    }) as OrchestrationV2ThreadProjection;
  for (const status of ["starting", "ready", "running", "waiting"])
    assert.equal(restartContinuationRun(withSessionStatus(status))?.id, runId, status);
  for (const status of ["stopped", "error"])
    assert.isUndefined(restartContinuationRun(withSessionStatus(status)), status);
});

it("recovers an admitted continuation after another crash before provider start", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "starting" as const,
        restartContinuationOfRunId: RunId.make("run:previous-crash"),
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  assert.equal(restartContinuationRun(starting)?.id, runId);
});

it("recovers an accepted steering restart before the replacement turn starts", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [{ ...projection.runs[0]!, status: "starting" as const }],
    attempts: [{ id: attemptId, runId, reason: "steering_restart" }],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(restartContinuationRun(starting)?.id, runId);
});

it("does not continue settled root runs with restart-cancelled background work", () => {
  const projection = makeProjection();
  const settled = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "completed" as const,
        restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  for (const projectId of [scratchProjectId, projection.thread.projectId])
    for (const status of ["completed", "waiting"] as const)
      assert.isUndefined(
        restartContinuationRun({
          ...settled,
          thread: { ...settled.thread, projectId },
          runs: [{ ...settled.runs[0]!, status }],
        }),
      );
});

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "ignores a pending restart continuation for a %s run whose provider turn settled",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [{ kind: "shell" as const, label: "sleep 25 && echo DONE" }];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 0);
    }),
);

it.effect("does not continue a failed run that lost background work", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection = {
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "failed",
          restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
        },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "failed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    assert.lengthOf(commands, 0);
  }),
);

it.effect.each([
  [false, undefined],
  [true, undefined],
  [false, true],
  [true, false],
] as const)(
  "atomically records restart intent with cancellation when opt-in is %s and project override is %s",
  ([enabled, projectOverride]) =>
    Effect.gen(function* () {
      let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              continueThreadsAfterServerUpdate: enabled,
              projectSettingsOverrides:
                projectOverride === undefined
                  ? {}
                  : {
                      [ProjectId.make("restart-project")]: {
                        continueThreadsAfterServerUpdate: projectOverride,
                      },
                    },
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(makeProjection()),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                committed = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      assert.isDefined(committed);
      assert.isTrue(
        committed!.events.some(
          (event) => event.type === "run.updated" && event.payload.status === "cancelled",
        ),
      );
      assert.lengthOf(committed!.effects, (projectOverride ?? enabled) ? 1 : 0);
      if (projectOverride ?? enabled)
        assert.deepEqual(committed!.effects[0]?.request, {
          type: "provider-runtime.continue",
          sourceRunId: runId,
        });
    }),
);

it.effect("does not duplicate delivery and yields to newer user work or opt-out", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    projection = { ...projection, runs: [{ ...projection.runs[0]!, status: "cancelled" }] };
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      recoverDelegatedTask: () => Effect.void,
      dispatch: (command) => {
        commands.push(command);
        if (command.type === "message.dispatch")
          projection = { ...projection, messages: [{ id: command.messageId } as never] };
        return Effect.succeed({} as never);
      },
    });
    const layerEnabled = Layer.merge(
      layerThreads,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    assert.match(String(commands[0]!.commandId), /run:restart$/);
    if (commands[0]!.type === "message.dispatch")
      assert.equal(commands[0]!.restartContinuationOfRunId, runId);
    projection = {
      ...projection,
      messages: [],
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          id: RunId.make("run:user-newer"),
          ordinal: 2,
          status: "completed",
        },
      ],
    };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    projection = { ...projection, runs: [projection.runs[0]!] };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          layerThreads,
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
        ),
      ),
    );
    assert.lengthOf(commands, 1);
  }),
);

it.effect("prepares no continuation for background work another provider thread launched", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
    // A Claude turn left a background subagent open, then the thread switched
    // to Codex and its turn settled. Recovery would cancel Claude's work.
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "completed" }],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      turnItems: [
        {
          id: "turn-item:claude-subagent",
          runId: RunId.make("run:claude"),
          providerThreadId: claudeThreadId,
          type: "subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
    // Work on the settled run's own provider thread must not wake it either.
    const ownWork = {
      ...projection,
      turnItems: [{ ...projection.turnItems[0]!, providerThreadId }],
    } as OrchestrationV2ThreadProjection;
    const ownRecovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(ownWork),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* ownRecovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
  }),
);

it.effect.each([
  ["completed", scratchProjectId],
  ["completed", ProjectId.make("restart-project")],
  ["waiting", scratchProjectId],
  ["waiting", ProjectId.make("restart-project")],
] as const)(
  "cleans up background work without waking a %s run in project %s",
  ([status, projectId]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: { ...base.thread, projectId },
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
        turnItems: [
          {
            id: "turn-item:background-subagent",
            runId,
            nodeId: null,
            providerThreadId,
            providerInstanceId: instanceId,
            type: "subagent",
            subagentId: "subagent:background",
            title: "Background reviewer",
            status: "running",
          },
        ],
        subagents: [
          {
            id: "subagent:background",
            runId,
            origin: "provider_native",
            driver,
            providerInstanceId: instanceId,
            status: "running",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      for (const trigger of ["startup", "shutdown"] as const) {
        const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
        const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
        const recovery = yield* ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeWithEffects: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    return [];
                  }),
                commitCommand: (input) =>
                  Effect.sync(() => {
                    commits.push(input);
                    return { committed: true, cancelledEffectCount: 0 } as never;
                  }),
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              }),
            ),
          ),
        );
        if (trigger === "shutdown") yield* recovery.prepareForShutdown;
        yield* recovery.reconcile(trigger);
        assert.lengthOf(writes, 0);
        assert.lengthOf(commits, 1);
        assert.lengthOf(commits[0]!.effects, 0);
        const events = commits[0]!.events;
        for (const type of ["turn-item.updated", "subagent.updated"] as const)
          assert.isTrue(
            events.some((event) => event.type === type && event.payload.status === "cancelled"),
          );
        const note = events.find((event) => event.type === "run.background-work-cancelled");
        assert.equal(note?.runId, runId);
        assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [
          { kind: "subagent", label: "Background reviewer", id: "turn-item:background-subagent" },
        ]);
        if (status === "completed")
          assert.isFalse(events.some((event) => event.type === "run.updated"));
      }
    }),
);

it.effect("does not cancel or resume a run that completes while shutdown intent commits", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                assert.lengthOf(input.events, 0);
                assert.equal(input.effects[0]?.request.type, "provider-runtime.continue");
                projection = {
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "completed" }],
                };
                return [];
              }),
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    yield* recovery.reconcile("shutdown");
    assert.isFalse(
      commits.some((commit) => commit.events.some((event) => event.type === "run.updated")),
    );
    let dispatched = false;
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
                return {} as never;
              }),
          }),
        ),
      ),
    );
    assert.isFalse(dispatched);
  }),
);

const continuationDispatches = (projection: OrchestrationV2ThreadProjection) =>
  Effect.gen(function* () {
    const dispatches: Array<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              if (command.type === "message.dispatch") dispatches.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    return dispatches;
  });

const continuationTexts = (projection: OrchestrationV2ThreadProjection) =>
  continuationDispatches(projection).pipe(
    Effect.map((dispatches) => dispatches.map((command) => command.text)),
  );

const cutMidTurn = (extra: Record<string, unknown> = {}) => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status: "cancelled",
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

it.effect(
  "delivers the replacement prompt when a steering restart never reached the provider",
  () =>
    Effect.gen(function* () {
      const projection = {
        ...cutMidTurn(),
        attempts: [{ id: attemptId, runId, reason: "steering_restart" }],
        providerTurns: [],
        messages: [
          {
            id: MessageId.make("message:user"),
            text: "Restart the review with the updated requirements.",
            attachments: [],
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      assert.deepEqual(yield* continuationTexts(projection), [projection.messages[0]!.text]);
    }),
);

it.effect.each(["interval", "fixed_time", "webhook"] as const)(
  "keeps %s task attribution through repeated restart continuations",
  (trigger) =>
    Effect.gen(function* () {
      const scheduledTaskId = ScheduledTaskId.make(`scheduled-task:${trigger}`);
      const originalMessage = {
        id: MessageId.make("message:user"),
        scheduledTaskId,
        text: trigger === "webhook" ? 'Handle {"action":"opened","number":7}.' : "Run the audit.",
        attachments: [],
      };
      const base = cutMidTurn();
      const messages = [originalMessage];
      const runs = [...base.runs];
      const projection = {
        ...base,
        messages,
        runs,
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      const dependencies = Layer.merge(
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          recoverDelegatedTask: () => Effect.void,
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({} as never);
          },
        }),
      );
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        const source = projection.runs.at(-1)!;
        yield* continueRestartedRun({ threadId, sourceRunId: source.id }).pipe(
          Effect.provide(dependencies),
        );
        const command = commands.at(-1)!;
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return;
        assert.equal(command.scheduledTaskId, scheduledTaskId);
        assert.equal(command.threadId, threadId);
        assert.equal(command.restartContinuationOfRunId, source.id);
        assert.equal(command.text, "Continue where you left off.");
        messages.push({
          id: command.messageId,
          text: command.text,
          scheduledTaskId: command.scheduledTaskId,
          attachments: [],
        } as never);
        runs.push({
          ...source,
          id: RunId.make(`run:continuation:${ordinal}`),
          ordinal: ordinal + 1,
          userMessageId: command.messageId,
          restartContinuationOfRunId: source.id,
        });
      }
      assert.lengthOf(commands, 2);
      assert.equal(projection.messages[0]?.text, originalMessage.text);
    }),
);

it.effect("stops continuing after three automatic restart continuations in a row", () =>
  Effect.gen(function* () {
    const first = RunId.make("run:first-continuation");
    const second = RunId.make("run:second-continuation");
    const cut = cutMidTurn({ restartContinuationOfRunId: second });
    const withTwoLinks = {
      ...cut,
      runs: [
        ...cut.runs,
        { ...cut.runs[0]!, id: second, restartContinuationOfRunId: first },
        { ...cut.runs[0]!, id: first, restartContinuationOfRunId: undefined },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withTwoLinks), 1);

    const withThreeLinks = {
      ...withTwoLinks,
      runs: withTwoLinks.runs.map((run) =>
        run.id === first ? { ...run, restartContinuationOfRunId: RunId.make("run:root") } : run,
      ),
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withThreeLinks), 0);
  }),
);

const queuedFollowUp = {
  id: RunId.make("run:queued"),
  ordinal: 2,
  providerInstanceId: instanceId,
  providerThreadId,
  status: "queued",
  queueHeld: true,
};

it.effect("continues a cut run past queued follow-ups, which stay held", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    assert.equal(
      restartContinuationRun({
        ...live,
        runs: [...live.runs, queuedFollowUp],
      } as unknown as OrchestrationV2ThreadProjection)?.id,
      runId,
    );
    const cut = cutMidTurn();
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, queuedFollowUp],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect.each([
  ["startup", true, false, false],
  ["shutdown", true, false, false],
  ["startup", false, false, false],
  ["shutdown", false, false, false],
  ["startup", true, true, false],
  ["startup", true, false, true],
] as const)(
  "preserves a queued worktree continuation through %s when enabled is %s, held is %s, extra queue is %s",
  ([trigger, enabled, alreadyHeld, extraQueue]) =>
    Effect.gen(function* () {
      const projection = {
        ...makeProjection(),
        thread: { ...makeProjection().thread, worktreePath: "/tmp/handoff-worktree" },
        runs: [
          {
            ...queuedFollowUp,
            queueHeld: alreadyHeld,
            userMessageId: MessageId.make("message:mcp:credential:worktree-continuation:request"),
          },
          ...(extraQueue ? [{ ...queuedFollowUp, id: RunId.make("run:other-queued") }] : []),
        ],
        providerThreads: [],
        providerSessions: [],
        providerTurns: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const events: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]["events"][number]
      > = [];
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: enabled }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) => {
                effects.push(...input.effects);
                return Effect.succeed([]);
              },
              commitCommand: (input) => {
                events.push(...input.events);
                effects.push(...input.effects);
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              cancelUnsettled: () => Effect.succeed([]),
              signalCancellations: () => Effect.void,
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile(trigger);
      const held =
        alreadyHeld ||
        events.some((event) => event.type === "run.updated" && event.payload.queueHeld === true);
      assert.equal(held, !enabled || alreadyHeld || extraQueue);
      assert.lengthOf(
        effects,
        trigger === "startup" && enabled && !alreadyHeld && !extraQueue ? 1 : 0,
      );
      if (effects.length > 0) assert.equal(effects[0]!.request.type, "provider-runtime.continue");
    }),
);

it.effect("delivers a queued handoff prompt once and respects cancellation before delivery", () =>
  Effect.gen(function* () {
    const message = {
      id: MessageId.make("message:mcp:credential:worktree-continuation:request"),
      text: "Keep fixing the login bug in the worktree.",
      attachments: [],
    };
    const base = cutMidTurn();
    const projection = {
      ...base,
      thread: { ...base.thread, worktreePath: "/tmp/handoff-worktree" },
      runs: [
        { ...base.runs[0]!, id: RunId.make("run:before-handoff"), ordinal: 1 },
        { ...queuedFollowUp, id: runId, userMessageId: message.id, queueHeld: false },
      ],
      messages: [message],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.deepEqual(yield* continuationTexts(projection), [message.text]);
    for (const status of ["queued", "cancelled"] as const) {
      assert.deepEqual(
        yield* continuationTexts({
          ...projection,
          runs: projection.runs.map((run) =>
            run.id === runId ? { ...run, status, queueHeld: true } : run,
          ),
        }),
        [],
      );
    }
  }),
);

it.effect("continues a resumed queued run that ran after an earlier continuation", () =>
  Effect.gen(function* () {
    // The continuation (ordinal 3) ran ahead of the held queue, then the user
    // resumed the queued run (ordinal 1 here) and the server restarted again.
    const finishedContinuation = {
      id: RunId.make("run:earlier-continuation"),
      ordinal: 3,
      providerInstanceId: instanceId,
      providerThreadId,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    };
    const live = makeProjection();
    assert.equal(
      restartContinuationRun({
        ...live,
        runs: [...live.runs, finishedContinuation],
      } as unknown as OrchestrationV2ThreadProjection)?.id,
      runId,
    );
    const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z") });
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, finishedContinuation],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, ["Continue where you left off."]);
  }),
);

it.effect("does not continue a run the user asked to stop before the restart", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      turnItems: [{ id: "turn-item:interrupt", runId, type: "run_interrupt_request" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, []);
  }),
);

it.effect("does not continue a cut /compact or /logout turn", () =>
  Effect.gen(function* () {
    for (const text of ["/compact", " /LOGOUT "]) {
      const texts = yield* continuationTexts({
        ...cutMidTurn(),
        messages: [{ id: MessageId.make("message:user"), text, attachments: [] }],
      } as unknown as OrchestrationV2ThreadProjection);
      assert.deepEqual(texts, [], text);
    }
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      messages: [{ id: MessageId.make("message:user"), text: "/compact later", attachments: [] }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
  }),
);

it.effect("tells a turn cut mid-way about the background work it lost", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts(
      cutMidTurn({
        restartCancelledBackgroundWork: [{ kind: "subagent", label: "Background reviewer" }],
      }),
    );
    assert.lengthOf(texts, 1);
    assert.include(texts[0]!, "Background reviewer");
    assert.isTrue(texts[0]!.endsWith("Continue where you left off."));
  }),
);

it.effect("shows a continuation as a T3 Code notice whose detail is the prompt", () =>
  Effect.gen(function* () {
    const [resumed] = yield* continuationDispatches(cutMidTurn());
    assert.deepEqual(resumed?.notification, {
      source: { kind: "system" },
      outcome: "updated",
      summary: "T3 Code restarted and resumed this turn",
      detail: "Continue where you left off.",
    });
  }),
);

it.effect(
  "carries the note forward when its continuation was cut before reaching the provider",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const original = {
        ...base.runs[0]!,
        id: RunId.make("run:original"),
        status: "completed",
        activeAttemptId: RunAttemptId.make("attempt:original"),
        restartCancelledBackgroundWork: [{ kind: "shell", label: "sleep 25 && echo DONE" }],
      };
      const projection = {
        ...base,
        runs: [
          original,
          {
            ...base.runs[0]!,
            ordinal: 2,
            status: "cancelled",
            restartContinuationOfRunId: original.id,
          },
        ],
        // The original turn settled; the continuation's attempt never started one.
        providerTurns: [
          {
            ...base.providerTurns[0]!,
            runAttemptId: original.activeAttemptId,
            status: "completed",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const texts = yield* continuationTexts(projection);
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, "sleep 25 && echo DONE");
      assert.notInclude(texts[0]!, "Continue where");
    }),
);

it.effect("prepares later threads' continuations when one thread fails", () =>
  Effect.gen(function* () {
    const brokenThreadId = ThreadId.make("thread:broken");
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([brokenThreadId, threadId]),
            getRuntimeRecoveryProjection: (id) =>
              id === brokenThreadId
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                  )
                : Effect.succeed(makeProjection()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.deepEqual(
      writes.map((write) => write.effects[0]?.request),
      [{ type: "provider-runtime.continue", sourceRunId: runId }],
    );
  }),
);

it.effect.each(["snoozed", "settled"] as const)(
  "does not wake a %s thread after a restart",
  (state) =>
    Effect.gen(function* () {
      const live = makeProjection();
      const thread = {
        ...live.thread,
        ...(state === "snoozed"
          ? { snoozedUntil: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z") }
          : { settledOverride: "settled" as const }),
      };
      assert.isUndefined(restartContinuationRun({ ...live, thread }));
      assert.deepEqual(yield* continuationTexts({ ...cutMidTurn(), thread }), []);
    }),
);

it.effect.each(["pending", "cancelled"] as const)(
  "does not continue a run whose secret request is %s at shutdown",
  (secretStatus) =>
    Effect.gen(function* () {
      const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
      const cut = cutMidTurn({ completedAt });
      const projection = {
        ...cut,
        turnItems: [{ type: "secret_request", runId, secretStatus, completedAt } as never],
      };
      if (secretStatus === "pending")
        assert.isUndefined(
          restartContinuationRun({ ...makeProjection(), turnItems: projection.turnItems }),
        );
      assert.deepEqual(yield* continuationTexts(projection), []);
    }),
);

it.effect("continues when an earlier attempt's question and secret were cancelled", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
    const cut = cutMidTurn({ completedAt });
    const earlierTurn = {
      ...cut.providerTurns[0]!,
      id: ProviderTurnId.make("turn:earlier-question"),
      runAttemptId: RunAttemptId.make("attempt:earlier-question"),
    };
    const projection = {
      ...cut,
      providerTurns: [...cut.providerTurns, earlierTurn],
      runtimeRequests: [
        {
          kind: "user_input",
          status: "expired",
          providerTurnId: earlierTurn.id,
          responseCapability: { type: "not_resumable", reason: "The server restarted." },
        } as never,
      ],
      turnItems: [
        {
          type: "secret_request",
          runId,
          secretStatus: "cancelled",
          completedAt: DateTime.subtract(completedAt, { seconds: 1 }),
        } as never,
        {
          type: "secret_request",
          runId: RunId.make("run:earlier-secret"),
          secretStatus: "pending",
          completedAt: null,
        } as never,
      ],
    };
    assert.lengthOf(yield* continuationTexts(projection), 1);
  }),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "does not continue when the provider turn %s before the app run settled",
  (status) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.deepEqual(
        yield* continuationTexts({
          ...cut,
          providerTurns: [{ ...cut.providerTurns[0]!, status }],
        }),
        [],
      );
    }),
);

it.effect("continues a cut goal turn after an earlier phase of the attempt completed", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn();
    assert.lengthOf(
      yield* continuationTexts({
        ...cut,
        providerTurns: [
          { ...cut.providerTurns[0]!, ordinal: 1, status: "completed" },
          {
            ...cut.providerTurns[0]!,
            id: ProviderTurnId.make("turn:goal-later"),
            ordinal: 2,
          },
        ],
      }),
      1,
    );
  }),
);
