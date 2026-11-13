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
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, continueRestartedRun } from "./RestartContinuation.ts";
import { continuationStartRetryDelayMs } from "./RestartBackgroundNote.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { backgroundSubagent, driver, instanceId, makeProjection, now, providerThreadId, runId, scratchProjectId, sessionId, threadId } from "./RestartContinuation-part2.test.ts";

const devServer = {
  turnItem: {
    id: "turn-item:dev-server",
    runId,
    nodeId: null,
    providerThreadId,
    providerInstanceId: instanceId,
    type: "command_execution",
    input: "vp run dev",
    status: "running",
  },
  work: { kind: "shell" as const, label: "vp run dev", id: "turn-item:dev-server" },
};

it.effect.each([
  ["completed", scratchProjectId, backgroundSubagent, true],
  ["waiting", ProjectId.make("restart-project"), backgroundSubagent, true],
  ["completed", ProjectId.make("restart-project"), devServer, false],
  ["waiting", scratchProjectId, devServer, false],
] as const)(
  "cleans up background work of a %s run in project %s and wakes it only for awaited work",
  ([status, projectId, background, wakes]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: { ...base.thread, projectId },
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
        turnItems: [background.turnItem],
        subagents:
          background === backgroundSubagent
            ? [
                {
                  id: "subagent:background",
                  runId,
                  origin: "provider_native",
                  driver,
                  providerInstanceId: instanceId,
                  status: "running",
                },
              ]
            : [],
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
        const recorded = [...writes.flatMap((write) => write.effects), ...commits[0]!.effects];
        assert.deepEqual(
          recorded.map((effect) => effect.request),
          wakes ? [{ type: "provider-runtime.continue", sourceRunId: runId }] : [],
        );
        assert.lengthOf(commits, 1);
        const events = commits[0]!.events;
        assert.isTrue(
          events.some(
            (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
          ),
        );
        const note = events.find((event) => event.type === "run.background-work-cancelled");
        assert.equal(note?.runId, runId);
        assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [background.work]);
        if (status === "completed")
          assert.isFalse(events.some((event) => event.type === "run.updated"));
      }
    }),
);

it("does not wake a settled run for work left by a session that already stopped", () => {
  const base = makeProjection();
  const projection = {
    ...base,
    runs: [{ ...base.runs[0]!, status: "completed" }],
    providerThreads: [{ ...base.providerThreads[0]!, status: "idle" }],
    turnItems: [backgroundSubagent.turnItem],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(restartContinuationRun(projection, now)?.id, runId);
  for (const status of ["stopped", "error"])
    assert.isUndefined(
      restartContinuationRun(
        {
          ...projection,
          providerSessions: [{ ...projection.providerSessions[0]!, status }],
        } as OrchestrationV2ThreadProjection,
        now,
      ),
      status,
    );
});

it.effect("wakes a run whose subagent's own shell the restart cut, past a wake it cut first", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const cutWake = {
      ...base.runs[0]!,
      id: RunId.make("run:wake"),
      ordinal: 2,
      status: "starting",
      startedAt: null,
    };
    const withShell = (parentTaskId?: string) =>
      ({
        ...base,
        runs: [{ ...base.runs[0]!, status: "waiting", startedAt: now }, cutWake],
        providerThreads: [
          {
            ...base.providerThreads[0]!,
            status: "idle",
            pendingBackgroundTasks: [
              {
                kind: "command",
                taskId: "shell:1",
                description: "sleep 150",
                ...(parentTaskId === undefined ? {} : { parentTaskId }),
              },
            ],
          },
        ],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      }) as unknown as OrchestrationV2ThreadProjection;
    assert.equal(restartContinuationRun(withShell("agent:1"), now)?.id, runId);
    assert.isUndefined(restartContinuationRun(withShell(), now));

    const texts = yield* continuationTexts({
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "completed",
          startedAt: now,
          completedAt: now,
          restartCancelledBackgroundWork: [
            { kind: "subagent", label: "sleep 150 (subagent agent:1)", id: "agent:1" },
          ],
        },
        { ...cutWake, status: "cancelled", completedAt: now },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
    assert.include(texts[0], "- subagent: sleep 150 (subagent agent:1)");
    const stopped = yield* continuationTexts({
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "completed",
          startedAt: now,
          completedAt: now,
          restartCancelledBackgroundWork: [
            { kind: "subagent", label: "sleep 150 (subagent agent:1)", id: "agent:1" },
          ],
        },
        { ...cutWake, status: "interrupted", completedAt: now },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(stopped, 0);
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

const continuationDispatches = (
  projection: OrchestrationV2ThreadProjection,
  sourceRunId: RunId = runId,
) =>
  Effect.gen(function* () {
    const dispatches: Array<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = [];
    yield* continueRestartedRun({ threadId, sourceRunId }).pipe(
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
        completedAt: now,
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

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
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, queuedFollowUp],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn();
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, queuedFollowUp],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, [
      "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.",
    ]);
  }),
);

it.effect("continues a resumed queued run that ran after an earlier continuation", () =>
  Effect.gen(function* () {
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
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, finishedContinuation],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z") });
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, finishedContinuation],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, [
      "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.",
    ]);
  }),
);

it("backs off twice from a continuation the provider never took, then lets it fail", () => {
  const base = makeProjection();
  const failedStart = (id: string, of: RunId) => ({
    ...base.runs[0]!,
    id: RunId.make(id),
    activeAttemptId: RunAttemptId.make(`attempt:${id}`),
    status: "failed" as const,
    restartContinuationOfRunId: of,
  });
  const first = failedStart("run:retry-1", runId);
  const second = failedStart("run:retry-2", first.id);
  const third = failedStart("run:retry-3", second.id);
  const projection = (failureClass = "provider_error", providerTurns = base.providerTurns) =>
    ({
      runs: [{ ...base.runs[0]!, status: "cancelled" }, first, second, third],
      providerTurns,
      turnItems: [first, second, third].map((run) => ({
        id: `error:${run.id}`,
        type: "error",
        status: "failed",
        runId: run.id,
        nodeId: run.rootNodeId,
        ordinal: 1,
        updatedAt: now,
        failure: { class: failureClass, message: "Failed.", code: null, retryable: null },
      })),
    }) as unknown as Parameters<typeof continuationStartRetryDelayMs>[1];
  assert.deepEqual(
    [first, second, third].map((run) => continuationStartRetryDelayMs(run, projection())),
    [60_000, 180_000, undefined],
  );
  for (const failureClass of ["usage_limit", "permission_error", "validation_error"])
    assert.isUndefined(continuationStartRetryDelayMs(first, projection(failureClass)));
  // Once the provider took the prompt, starting again would repeat the turn.
  assert.isUndefined(
    continuationStartRetryDelayMs(
      first,
      projection("provider_error", [
        { ...base.providerTurns[0]!, runAttemptId: first.activeAttemptId, status: "failed" },
      ] as never),
    ),
  );
});

it.effect("continues again after a continuation fails before its prompt", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn();
    const failedStart = {
      ...cut.runs[0]!,
      id: RunId.make("run:failed-start"),
      ordinal: 2,
      activeAttemptId: RunAttemptId.make("attempt:failed-start"),
      status: "failed",
      restartContinuationOfRunId: runId,
    };
    const dispatches = yield* continuationDispatches(
      { ...cut, runs: [...cut.runs, failedStart] } as unknown as OrchestrationV2ThreadProjection,
      failedStart.id,
    );
    assert.deepEqual(
      dispatches.map((command) => command.restartContinuationOfRunId),
      [failedStart.id],
    );
  }),
);

it.effect.each([
  ["running", null, 0],
  ["completed", "Done.", 1],
] as const)(
  "a parent's Stop on the task's run blocks the child only while the task is %s",
  ([status, result, expected]) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:parent");
      const parentRunId = RunId.make("run:parent");
      const taskId = NodeId.make("node:task");
      const cut = cutMidTurn();
      const child = {
        ...cut,
        thread: {
          ...cut.thread,
          lineage: { parentThreadId, relationshipToParent: "subagent" },
          forkedFrom: { type: "node", nodeId: taskId },
        },
      } as unknown as OrchestrationV2ThreadProjection;
      const parent = {
        thread: { id: parentThreadId },
        subagents: [{ id: taskId, runId: parentRunId, origin: "app_owned", status, result }],
        turnItems: [{ id: "turn-item:stop", runId: parentRunId, type: "run_interrupt_request" }],
      };
      let dispatched = 0;
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: (id) =>
                Effect.succeed((id === parentThreadId ? parent : child) as never),
              recoverDelegatedTask: () => Effect.void,
              dispatch: () =>
                Effect.sync(() => {
                  dispatched += 1;
                  return {} as never;
                }),
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.equal(dispatched, expected);
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

it.effect.each([
  ["user_input", "pending", "live", false],
  ["user_input", "expired", "not_resumable", false],
  ["user_input", "cancelled", "not_resumable", false],
  ["command", "pending", "live", false],
  ["command", "expired", "not_resumable", false],
  ["user_input", "resolved", "live", true],
  ["command", "cancelled", "live", true],
  ["user_input", "pending", "message", true],
  ["dynamic_tool_call", "pending", "live", true],
  ["auth_refresh", "pending", "live", true],
] as const)(
  "a %s request that is %s with %s capability allows continuation: %s",
  ([kind, status, capability, shouldContinue]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const runtimeRequests = [
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
                ? { type: capability, reason: "The server restarted." }
                : { type: capability },
        },
      ];
      const live = { ...base, runtimeRequests } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(live, now) !== undefined, shouldContinue);
      const cut = {
        ...cutMidTurn(),
        runtimeRequests,
      } as unknown as OrchestrationV2ThreadProjection;
      assert.lengthOf(yield* continuationTexts(cut), shouldContinue ? 1 : 0);
    }),
);

it.effect("does not wake a snoozed or settled thread, but continues once a snooze elapsed", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    for (const held of [
      { snoozedUntil: DateTime.add(now, { days: 1 }) },
      { settledOverride: "settled" as const },
    ]) {
      const thread = { ...live.thread, ...held };
      assert.isUndefined(restartContinuationRun({ ...live, thread }, now));
      assert.deepEqual(yield* continuationTexts({ ...cutMidTurn(), thread }), []);
    }
    const thread = { ...live.thread, snoozedUntil: DateTime.subtract(now, { minutes: 1 }) };
    assert.equal(restartContinuationRun({ ...live, thread }, now)?.id, runId);
  }),
);

it.effect("does not continue a run waiting on a secret the restart closed", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
    const secret = (secretStatus: string, at: DateTime.Utc | null) =>
      ({ type: "secret_request", runId, secretStatus, completedAt: at }) as never;
    assert.isUndefined(
      restartContinuationRun({ ...makeProjection(), turnItems: [secret("pending", null)] }, now),
    );
    const cut = cutMidTurn({ completedAt });
    assert.deepEqual(
      yield* continuationTexts({ ...cut, turnItems: [secret("cancelled", completedAt)] }),
      [],
    );
    assert.lengthOf(
      yield* continuationTexts({
        ...cut,
        turnItems: [secret("cancelled", DateTime.subtract(completedAt, { seconds: 1 }))],
      }),
      1,
    );
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
