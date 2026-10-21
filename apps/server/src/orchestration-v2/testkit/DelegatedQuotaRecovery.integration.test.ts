import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ProviderTurnStartService from "../ProviderTurnStartService.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type DelegatedLaunchBinding,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { ProviderInstance, DelegatedLaunchPool } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Harness from "./ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const domain = "codex:credential:synthetic-workspace";
const failure = {
  class: "usage_limit" as const,
  message: "quota refusal",
  code: "usage_limit",
  retryable: false,
};

it.effect.each([
  "terminal",
  "transport",
  "unavailable",
  "restart-pending",
  "restart-established",
  "restart-new-run",
  "output",
  "tool",
  "stream",
  "fallback",
  "account-throttle",
  "throttle-restart",
  "expired",
] as const)("handles delegated %s through persisted parent/task projections", (mode) =>
  Effect.gen(function* () {
    let starts = 0;
    let invalidated = false;
    const isThrottle = mode === "account-throttle" || mode === "throttle-restart";
    const canFallback = mode === "fallback" || isThrottle;
    let restartChild: ThreadId | undefined;
    let restartRun: RunId | undefined;
    let persistedBinding: DelegatedLaunchBinding | undefined;
    const opened: Array<DelegatedLaunchBinding | undefined> = [];
    const pool: DelegatedLaunchPool = {
      prepare: (request) =>
        Effect.gen(function* () {
          if (
            invalidated ||
            ((request.blockedQuotaDomains.includes(domain) ||
              request.blockedQuotaDomains.includes(`launch:attempt:${domain}`)) &&
              !canFallback)
          )
            return { status: "waiting", quotaDomains: [domain] };
          const now = yield* DateTime.now;
          const sessionId = `session-${request.generation}`;
          const bindingId = "a".repeat(48);
          const binding: DelegatedLaunchBinding = {
            protocol: "codex-t3-pool-v2",
            instanceId,
            prepareRequest: {
              clientRequestId: `prepare-${request.generation}`,
              sessionId,
              provider: "codex",
              model: request.model,
              blockedQuotaDomains: [],
            },
            result: {
              protocolVersion: 2,
              status: "ready",
              checkedAt: DateTime.formatIso(now),
              expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: 30 })),
              ordinaryUsageAllowed: true,
              quotaDomains: [
                request.blockedQuotaDomains.includes(domain) ||
                request.blockedQuotaDomains.includes(`launch:attempt:${domain}`)
                  ? `${domain}-spare`
                  : domain,
              ],
              bindingId,
              basePath: `/v1/delegated-launch/bindings/${bindingId}/sessions/${sessionId}`,
              provider: "codex",
              model: request.model,
              sessionId,
              windows: [
                {
                  id: "primary",
                  usedPercent: 1,
                  resetsAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
                },
              ],
            },
          };
          return { status: "ready", binding };
        }),
      state: () =>
        mode === "unavailable"
          ? Effect.succeed(undefined)
          : mode === "expired"
            ? Effect.succeed({
                protocolVersion: 2,
                state: "pending",
                active: false,
                executorAttempts: 0,
                refusalVersion: 0,
              })
            : Effect.succeed({
                protocolVersion: 2,
                state: "established",
                active: false,
                executorAttempts: 1,
                refusalVersion: 1,
                refusal: {
                  code: isThrottle ? "throttled" : "usage_limit",
                  quotaScope: isThrottle ? "transient" : "account",
                  quotaDomains: isThrottle ? [] : [domain],
                  ...(isThrottle ? { attemptedAccountDomain: domain } : {}),
                },
              }),
      release: () => Effect.succeed(true),
      cancel: () => Effect.succeed(true),
      touch: () => Effect.succeed(true),
      resume: () => Effect.succeed(true),
    };
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          opened.push(input.delegatedLaunchBinding);
          if (mode === "expired") {
            yield* TestClock.adjust("31 seconds");
            return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: "pending lease expired",
            });
          }
          if (invalidated)
            return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: "Established binding unavailable after restart",
            });
          const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const now = yield* DateTime.now;
          const streamFailed = yield* Deferred.make<void>();
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: input.runtimePolicy.cwd ?? process.cwd(),
              model: input.modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events:
              mode === "stream"
                ? Stream.fromEffect(Deferred.await(streamFailed)).pipe(
                    Stream.flatMap(() =>
                      Stream.fail(
                        new ProviderAdapter.ProviderAdapterEventStreamError({
                          driver,
                          providerSessionId: input.providerSessionId,
                          cause: { code: "usage_limit" },
                        }),
                      ),
                    ),
                  )
                : Stream.fromPubSub(events),
            ensureThread: (request) =>
              Effect.succeed({
                id: ProviderThreadId.make(`native:${request.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: request.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native:${request.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                starts++;
                if (mode === "stream") {
                  yield* Deferred.succeed(streamFailed, undefined);
                  return;
                }
                if (mode !== "terminal" && mode !== "output" && mode !== "tool" && !canFallback)
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                    cause: { code: "usage_limit" },
                  });
                const providerTurnId = ProviderTurnId.make(`turn:${turn.runId}`);
                const base = { driver, providerThreadId: turn.providerThread.id, providerTurnId };
                yield* PubSub.publish(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    ordinal: 1,
                    status: "running",
                    nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" },
                    startedAt: now,
                    completedAt: null,
                  },
                });
                if (mode === "output" || mode === "tool" || (canFallback && starts === 2)) {
                  const common = {
                    id: TurnItemId.make(`work:${turn.runId}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed" as const,
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  };
                  yield* PubSub.publish(events, {
                    type: "turn_item.updated",
                    driver,
                    turnItem:
                      mode !== "tool"
                        ? {
                            ...common,
                            type: "assistant_message",
                            messageId: MessageId.make(`output:${turn.runId}`),
                            text: "useful result",
                            streaming: false,
                          }
                        : {
                            ...common,
                            type: "command_execution",
                            input: "synthetic-tool",
                            output: "performed",
                            exitCode: 0,
                          },
                  });
                }
                if (canFallback && starts === 2) {
                  yield* PubSub.publish(events, {
                    ...base,
                    type: "turn.terminal",
                    runOrdinal: turn.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                  return;
                }
                yield* PubSub.publish(events, {
                  ...base,
                  type: "turn_item.updated",
                  turnItem: {
                    id: TurnItemId.make(`error:${turn.runId}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    type: "error",
                    status: "failed",
                    title: "quota",
                    failure,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                });
                yield* PubSub.publish(events, {
                  ...base,
                  type: "turn.terminal",
                  runOrdinal: turn.runOrdinal,
                  status: "failed",
                  failureItemOrdinal: 2,
                  failure,
                  threadDisposition: "reusable",
                });
              }),
            steerTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("not used"),
            rollbackThread: () => Effect.die("not used"),
            forkThread: () => Effect.die("not used"),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
    };
    const provider = {
      instanceId,
      driver,
      displayName: "synthetic",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: modelSelection.model, label: modelSelection.model }],
      checkedAt: "2026-10-21T00:00:00Z",
      capabilities: {},
    } as unknown as ServerProvider;
    const instance = {
      instanceId,
      driverKind: driver,
      enabled: true,
      delegatedLaunchPool: pool,
      snapshot: { getSnapshot: Effect.succeed(provider) },
    } as unknown as ProviderInstance;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "bound-recovery-" });
    const database = SqlitePersistence.layerFromPath(`${directory}/state.sqlite`).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = Harness.layerWithRegistry(
      { name: `delegated-quota-${mode}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        providerInstances: {
          getInstance: () => Effect.succeed(instance),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.never,
          subscribeChanges: Effect.die("unused"),
        },
      },
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const parentThreadId = ThreadId.make(`parent:${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${mode}`),
        threadId: parentThreadId,
        projectId: ProjectId.make(`project:${mode}`),
        title: "parent",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`parent-run:${mode}`),
        threadId: parentThreadId,
        messageId: MessageId.make(`message:${mode}`),
        text: "delegate",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const parentRun = parent.runs[0]!;
      const request = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make(`request:${mode}`),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "synthetic child",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      yield* orchestrator.dispatch(request);
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
      assert.ok(task.childThreadId);
      if (mode.startsWith("restart-")) {
        const child = yield* orchestrator.getThreadProjection(task.childThreadId);
        const run = child.runs[0]!;
        const ready = yield* pool.prepare({
          runId: run.id,
          generation: 0,
          model: modelSelection.model,
          blockedQuotaDomains: [],
        });
        assert.equal(ready.status, "ready");
        if (ready.status !== "ready") return;
        persistedBinding = ready.binding;
        restartChild = task.childThreadId;
        restartRun = run.id;
        const now = yield* DateTime.now;
        if (mode === "restart-new-run")
          yield* sink.write({
            events: [
              {
                id: EventId.make("advance-continuation"),
                type: "run.updated",
                threadId: task.childThreadId,
                occurredAt: now,
                payload: { ...run, ordinal: 2 },
              },
            ],
          });
        yield* sink.write({
          events: [
            {
              id: EventId.make(`persist-binding:${mode}`),
              type: mode === "restart-new-run" ? "run.created" : "run.updated",
              threadId: task.childThreadId,
              occurredAt: now,
              payload: {
                ...run,
                ...(mode === "restart-new-run"
                  ? {
                      id: RunId.make(`${run.id}:previous`),
                      ordinal: 1,
                      status: "completed" as const,
                      completedAt: now,
                      rootNodeId: null,
                      activeAttemptId: null,
                    }
                  : {}),
                delegatedLaunch: {
                  requested: modelSelection,
                  blockedDomains: [],
                  admittedDomains: [domain],
                  generation: 0,
                  blockedUntil: DateTime.formatIso(now),
                  binding: ready.binding,
                  ...(mode !== "restart-pending" ? { complete: true } : {}),
                },
              },
            },
          ],
        });
        return;
      }
      const sequence = yield* sink.latestSequence();
      yield* worker.drain();
      if (mode === "output" || mode === "tool") {
        yield* sink.stream({ afterSequence: sequence }).pipe(
          Stream.filter(
            (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const child = yield* orchestrator.getThreadProjection(task.childThreadId);
        assert.equal(child.runs[0]?.status, "failed");
        assert.isTrue(child.runs[0]?.delegatedLaunch?.complete);
        assert.equal(child.runs[0]?.delegatedLaunch?.generation, 0);
        assert.equal(starts, 1);
        return;
      }
      // Recovery commits before its outbox retry is drained. Read the committed
      // stream, so the assertion covers every intermediate parent projection.
      const recovered = yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter(
          (e) =>
            e.event.type === "run.updated" &&
            (e.event.payload.delegatedLaunch?.generation === 1 ||
              e.event.payload.status === "failed"),
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(recovered.length, 1);
      const recoveredEvent = recovered[0]!.event;
      assert.equal(recoveredEvent.type, "run.updated");
      if (recoveredEvent.type === "run.updated")
        assert.equal(recoveredEvent.payload.delegatedLaunch?.generation, 1);
      if (isThrottle && recoveredEvent.type === "run.updated") {
        assert.deepEqual(recoveredEvent.payload.delegatedLaunch?.blockedDomains, [
          `launch:attempt:${domain}`,
        ]);
        yield* orchestrator.dispatch(request);
        assert.lengthOf((yield* orchestrator.getThreadProjection(parentThreadId)).subagents, 1);
        assert.equal(starts, 1);
        if (mode === "throttle-restart") {
          restartChild = task.childThreadId;
          restartRun = recoveredEvent.payload.id;
          return;
        }
      }
      yield* worker.drain();
      if (canFallback)
        yield* sink.stream({ afterSequence: sequence }).pipe(
          Stream.filter(
            (e) =>
              e.event.type === "run.updated" &&
              (e.event.payload.status === "waiting" || e.event.payload.status === "completed"),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      const child = yield* orchestrator.getThreadProjection(task.childThreadId);
      const history = yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.takeUntil(
          (e) =>
            e.event.type === "run.updated" &&
            (e.event.payload.capacityWait !== undefined ||
              e.event.payload.status === "waiting" ||
              e.event.payload.status === "completed"),
        ),
        Stream.runCollect,
      );
      for (const { event } of history) {
        if (event.type === "run.updated" || event.type === "subagent.updated")
          assert.notEqual(event.payload.status, "failed");
      }
      if (canFallback) {
        assert.equal(starts, 2);
        assert.equal(opened[1]?.result.quotaDomains[0], `${domain}-spare`);
        assert.equal(child.runs[0]?.modelSelection.model, modelSelection.model);
        assert.notEqual(
          (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]?.status,
          "failed",
        );
        return;
      }
      assert.equal(child.runs[0]?.status, "starting");
      assert.ok(child.runs[0]?.capacityWait);
      if (mode === "expired") assert.notEqual(child.runs[0]?.capacityWait?.reason, "exhausted");
      assert.equal(starts, mode === "expired" ? 0 : 1);
      assert.ok(opened[0]);
      const events = yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.takeUntil(
          (e) => e.event.type === "run.updated" && e.event.payload.capacityWait !== undefined,
        ),
        Stream.runCollect,
      );
      for (const stored of events) {
        const e: OrchestrationV2DomainEvent = stored.event;
        if (e.type === "subagent.updated") assert.notEqual(e.payload.status, "failed");
        if (e.type === "run.updated") assert.notEqual(e.payload.status, "failed");
      }
      yield* orchestrator.dispatch(request);
      assert.lengthOf((yield* orchestrator.getThreadProjection(parentThreadId)).subagents, 1);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`cancel:${mode}`),
        threadId: task.childThreadId,
        runId: child.runs[0]!.id,
      });
      yield* worker.drain();
      assert.equal(starts, mode === "expired" ? 0 : 1);
    }).pipe(Effect.provide(layer));
    if (restartChild && restartRun) {
      invalidated = mode !== "throttle-restart";
      const threadId = restartChild;
      const runId = restartRun;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const start = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
        yield* start
          .start({
            threadId,
            runId,
            ...(mode === "throttle-restart" ? { launchGeneration: 1 } : {}),
          })
          .pipe(Effect.exit);
        if (mode === "throttle-restart") {
          const child = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(child.runs[0]?.delegatedLaunch?.blockedDomains, [
            `launch:attempt:${domain}`,
          ]);
          assert.equal(opened[1]?.result.quotaDomains[0], `${domain}-spare`);
          assert.equal(starts, 2);
          yield* start
            .start({
              threadId,
              runId,
              ...(mode === "throttle-restart" ? { launchGeneration: 1 } : {}),
            })
            .pipe(Effect.exit);
          assert.equal(starts, 2);
          return;
        }
        const child = yield* orchestrator.getThreadProjection(threadId);
        const current = child.runs.find((run) => run.id === runId)!;
        assert.deepEqual(
          current?.delegatedLaunch?.binding,
          mode === "restart-established" ? persistedBinding : undefined,
        );
        assert.equal(starts, 0);
        if (mode === "restart-pending") {
          assert.ok(current?.capacityWait);
          assert.equal(current?.status, "starting");
          assert.lengthOf(opened, 0);
        } else {
          assert.deepEqual(opened, [persistedBinding]);
          assert.equal(current?.status, "failed");
        }
      }).pipe(Effect.provide(Layer.fresh(layer)));
    }
  }).pipe(Effect.timeout("2 minutes"), Effect.provide(NodeServices.layer)),
);
