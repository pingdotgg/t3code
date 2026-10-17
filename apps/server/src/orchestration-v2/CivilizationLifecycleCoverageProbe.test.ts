import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "g6-probe-model" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("G6 never starts a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerProbe = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "civilization-g6-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerNativeDatabase = SqlitePersistence.layerMemory;
const layerNativeStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerNativeDatabase),
);
const layerNativeSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerNativeStores, layerNativeDatabase)),
);
const layerNativeGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "civilization-g6-native-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerNative = Layer.mergeAll(
  layerNativeDatabase,
  layerNativeStores,
  layerNativeSink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  layerNativeGit,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNativeStores,
        layerNativeSink,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        layerNativeGit,
      ),
    ),
  ),
);

const isAppThread = Schema.is(OrchestrationV2AppThread);

interface ProbeCitizen {
  readonly threadId: ThreadId;
  epoch: number;
  closed: boolean;
  deleted: boolean;
  lastAppliedSequence: number;
}

interface ProbeMail {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly epoch: number;
  closed: boolean;
}

function effectiveClosed(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.settledOverride === "settled" || thread.archivedAt !== null || thread.deletedAt !== null
  );
}

function makeLifecycleProbe() {
  const citizens = new Map<ThreadId, ProbeCitizen>();
  const mail = new Map<string, ProbeMail>();

  const apply = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) => {
    let applied = 0;
    let transitions = 0;
    let enrollments = 0;
    for (const stored of storedEvents) {
      const event = stored.event;
      if (event.type === "thread.created" && !citizens.has(event.threadId)) {
        const thread = event.payload;
        citizens.set(event.threadId, {
          threadId: event.threadId,
          epoch: 0,
          closed: effectiveClosed(thread),
          deleted: thread.deletedAt !== null,
          lastAppliedSequence: stored.sequence - 1,
        });
        enrollments += 1;
      }

      const citizen = citizens.get(event.threadId);
      if (citizen === undefined || stored.sequence <= citizen.lastAppliedSequence) continue;

      if (isAppThread(event.payload) && event.payload.id === event.threadId) {
        const nextClosed = effectiveClosed(event.payload);
        const nextDeleted = event.payload.deletedAt !== null;
        if (nextClosed !== citizen.closed) {
          citizen.epoch += 1;
          citizen.closed = nextClosed;
          transitions += 1;
          if (nextClosed) {
            for (const envelope of mail.values()) {
              if (envelope.threadId === citizen.threadId && !envelope.closed)
                envelope.closed = true;
            }
          }
        }
        citizen.deleted = nextDeleted;
      }
      citizen.lastAppliedSequence = stored.sequence;
      applied += 1;
    }
    return { applied, transitions, enrollments };
  };

  const offerMail = (threadId: ThreadId, id: string) => {
    const citizen = citizens.get(threadId);
    assert.isDefined(citizen);
    const envelope: ProbeMail = {
      id,
      threadId,
      epoch: citizen!.epoch,
      closed: citizen!.closed,
    };
    mail.set(id, envelope);
    return envelope;
  };

  return { citizens, mail, apply, offerMail };
}

const createThreadCommand = (input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly title?: string;
}) =>
  ({
    type: "thread.create",
    commandId: CommandId.make(input.commandId),
    threadId: input.threadId,
    projectId: input.projectId ?? ProjectId.make("project:g6"),
    title: input.title ?? input.threadId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  }) as const;

it.effect("covers creation, fork and app-owned child identities without duplicate enrollment", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const feature = makeLifecycleProbe();

    const directId = ThreadId.make("thread:g6:direct");
    const direct = yield* orchestrator.dispatch(
      createThreadCommand({ commandId: "g6:create:direct", threadId: directId }),
    );
    assert.deepEqual(feature.apply(direct.storedEvents), {
      applied: direct.storedEvents.length,
      transitions: 0,
      enrollments: 1,
    });

    const importedId = ThreadId.make("thread:g6:imported");
    const importCommand = {
      ...createThreadCommand({ commandId: "g6:create:imported", threadId: importedId }),
      importedNativeThread: {
        ref: { driver, nativeId: "native:g6:imported", strength: "strong" as const },
        metadata: { itemIdentityVersion: 2 as const, title: "Imported G6" },
      },
    };
    const imported = yield* orchestrator.dispatch(importCommand);
    assert.equal(feature.apply(imported.storedEvents).enrollments, 1);
    assert.equal(feature.citizens.get(importedId)?.epoch, 0);
    assert.isTrue(
      imported.storedEvents.some((stored) => stored.event.type === "provider-thread.updated"),
    );

    // Command receipt replay returns the same committed events. The feature
    // watermark makes replay a no-op and preserves one identity for the thread.
    const importedReplay = yield* orchestrator.dispatch(importCommand);
    assert.equal(feature.apply(importedReplay.storedEvents).applied, 0);
    assert.equal(
      [...feature.citizens.values()].filter((citizen) => citizen.threadId === importedId).length,
      1,
    );

    const sourceId = ThreadId.make("thread:g6:fork-source");
    const sourceCreate = yield* orchestrator.dispatch(
      createThreadCommand({ commandId: "g6:create:fork-source", threadId: sourceId }),
    );
    feature.apply(sourceCreate.storedEvents);
    const sourceRunId = RunId.make("run:g6:fork-source");
    const now = yield* DateTime.now;
    const runFixture = yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:g6:fork-source-run"),
          type: "run.created",
          threadId: sourceId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:g6:fork-source"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    feature.apply(runFixture);
    const forkId = ThreadId.make("thread:g6:fork-target");
    const forked = yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("g6:fork"),
      sourceThreadId: sourceId,
      targetThreadId: forkId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "web",
    });
    const forkApplied = feature.apply(forked.storedEvents);
    assert.equal(forkApplied.enrollments, 1);
    assert.equal(feature.citizens.get(forkId)?.epoch, 0);
    assert.isTrue(forked.storedEvents.some((stored) => stored.event.type === "thread.created"));

    const parentId = ThreadId.make("thread:g6:delegate-parent");
    const parentCreated = yield* orchestrator.dispatch(
      createThreadCommand({ commandId: "g6:create:delegate-parent", threadId: parentId }),
    );
    feature.apply(parentCreated.storedEvents);
    const parentStarted = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("g6:start:delegate-parent"),
      threadId: parentId,
      messageId: MessageId.make("message:g6:delegate-parent"),
      text: "Delegate a synthetic task",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    feature.apply(parentStarted.storedEvents);
    const parentProjection = yield* projections.getThreadProjection(parentId);
    const parentRun = parentProjection.runs[0]!;
    assert.isNotNull(parentRun.rootNodeId);
    const delegated = yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("g6:delegate"),
      parentThreadId: parentId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Inspect the synthetic fixture",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childCreated = delegated.storedEvents.find(
      (stored) => stored.event.type === "thread.created",
    );
    assert.isDefined(childCreated);
    const childId = childCreated!.event.threadId;
    assert.equal(feature.apply(delegated.storedEvents).enrollments, 1);
    assert.equal(feature.citizens.get(childId)?.epoch, 0);
    assert.equal((yield* projections.getThread(childId)).lineage.parentThreadId, parentId);

    for (const threadId of [directId, importedId, sourceId, forkId, parentId, childId]) {
      assert.equal(feature.citizens.has(threadId), true);
    }
    assert.equal(feature.citizens.size, 6);
  }).pipe(Effect.provide(layerProbe)),
);

it.effect("enrolls provider-native projections once and treats repeated offers as idempotent", () =>
  Effect.gen(function* () {
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const feature = makeLifecycleProbe();
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g6:native-projection");
    const appThread: OrchestrationV2AppThread = {
      createdBy: "agent",
      creationSource: "provider",
      id: threadId,
      projectId: ProjectId.make("project:g6:native"),
      title: "Native G6 projection",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const input = {
      providerSessionId: ProviderSessionId.make("session:g6:native"),
      providerInstanceId: instanceId,
      threadId,
      event: { type: "app_thread.created" as const, driver, appThread },
    };

    const created = yield* ingestor.ingestNormalized(input);
    assert.equal(created[0]?.event.type, "thread.created");
    assert.deepEqual(feature.apply(created), {
      applied: created.length,
      transitions: 0,
      enrollments: 1,
    });
    assert.equal(feature.citizens.get(threadId)?.epoch, 0);

    const replay = yield* ingestor.ingestNormalized(input);
    assert.lengthOf(replay, 0);
    assert.equal(feature.apply(replay).applied, 0);
    assert.equal(feature.citizens.size, 1);
  }).pipe(Effect.provide(layerNative)),
);

it.effect("derives close and reopen epochs from resulting thread state", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const feature = makeLifecycleProbe();
    const threadId = ThreadId.make("thread:g6:lifecycle");

    const created = yield* orchestrator.dispatch(
      createThreadCommand({ commandId: "g6:lifecycle:create", threadId }),
    );
    feature.apply(created.storedEvents);
    const firstMail = feature.offerMail(threadId, "mail:g6:first");
    assert.equal(firstMail.epoch, 0);
    assert.isFalse(firstMail.closed);

    const settled = yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("g6:lifecycle:settle"),
      threadId,
    });
    assert.equal(feature.apply(settled.storedEvents).transitions, 1);
    assert.deepEqual(
      {
        epoch: feature.citizens.get(threadId)?.epoch,
        closed: feature.citizens.get(threadId)?.closed,
      },
      { epoch: 1, closed: true },
    );
    assert.isTrue(firstMail.closed);

    const redundantSettle = yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("g6:lifecycle:settle-again"),
      threadId,
    });
    assert.isTrue(
      redundantSettle.storedEvents.some((stored) => stored.event.type === "thread.settled"),
    );
    assert.equal(feature.apply(redundantSettle.storedEvents).transitions, 0);
    assert.equal(feature.citizens.get(threadId)?.epoch, 1);

    const pinned = yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("g6:lifecycle:pin"),
      threadId,
    });
    assert.isTrue(pinned.storedEvents.some((stored) => stored.event.type === "thread.pinned"));
    assert.equal(feature.apply(pinned.storedEvents).transitions, 1);
    assert.deepEqual(
      {
        epoch: feature.citizens.get(threadId)?.epoch,
        closed: feature.citizens.get(threadId)?.closed,
      },
      { epoch: 2, closed: false },
    );
    assert.isTrue(firstMail.closed);
    const reopenedMail = feature.offerMail(threadId, "mail:g6:reopened");
    assert.equal(reopenedMail.epoch, 2);
    assert.isFalse(reopenedMail.closed);

    const settleAgain = yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("g6:lifecycle:settle-after-pin"),
      threadId,
    });
    assert.equal(feature.apply(settleAgain.storedEvents).transitions, 1);
    assert.equal(feature.citizens.get(threadId)?.epoch, 3);

    const archived = yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("g6:lifecycle:archive"),
      threadId,
    });
    assert.equal(feature.apply(archived.storedEvents).transitions, 0);
    const unarchived = yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("g6:lifecycle:unarchive"),
      threadId,
    });
    assert.isTrue(
      unarchived.storedEvents.some((stored) => stored.event.type === "thread.unarchived"),
    );
    assert.equal(feature.apply(unarchived.storedEvents).transitions, 0);
    assert.deepEqual(
      {
        epoch: feature.citizens.get(threadId)?.epoch,
        closed: feature.citizens.get(threadId)?.closed,
      },
      { epoch: 3, closed: true },
    );

    const dispatchReturn = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("g6:lifecycle:return"),
      threadId,
      messageId: MessageId.make("message:g6:return"),
      text: "Return to the settled thread",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.isTrue(
      dispatchReturn.storedEvents.some((stored) => stored.event.type === "thread.unsettled"),
    );
    assert.equal(feature.apply(dispatchReturn.storedEvents).transitions, 1);
    assert.equal(feature.citizens.get(threadId)?.epoch, 4);
    assert.isFalse(feature.citizens.get(threadId)!.closed);

    const explicitActive = yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("g6:lifecycle:active-override"),
      threadId,
      reason: "user",
    });
    assert.equal(feature.apply(explicitActive.storedEvents).transitions, 0);
    const dispatchActive = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("g6:lifecycle:return-active"),
      threadId,
      messageId: MessageId.make("message:g6:return-active"),
      text: "Return while explicitly active",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.isTrue(
      dispatchActive.storedEvents.some((stored) => stored.event.type === "thread.unsettled"),
    );
    assert.equal(feature.apply(dispatchActive.storedEvents).transitions, 0);
    assert.equal(feature.citizens.get(threadId)?.epoch, 4);

    const snoozeId = ThreadId.make("thread:g6:snooze");
    feature.apply(
      (yield* orchestrator.dispatch(
        createThreadCommand({ commandId: "g6:lifecycle:snooze-create", threadId: snoozeId }),
      )).storedEvents,
    );
    const wake = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
    const snoozed = yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("g6:lifecycle:snooze"),
      threadId: snoozeId,
      snoozedUntil: wake,
    });
    assert.equal(feature.apply(snoozed.storedEvents).transitions, 0);
    assert.equal(feature.citizens.get(snoozeId)?.epoch, 0);
    assert.isNotNull((yield* projections.getThread(snoozeId)).snoozedUntil);
    assert.equal(feature.apply(snoozed.storedEvents).applied, 0);
  }).pipe(Effect.provide(layerProbe)),
);

it.effect("covers automatic settlement and terminal deletion without false epochs", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const feature = makeLifecycleProbe();

    const autoId = ThreadId.make("thread:g6:auto-settle");
    feature.apply(
      (yield* orchestrator.dispatch(
        createThreadCommand({ commandId: "g6:auto:create", threadId: autoId }),
      )).storedEvents,
    );
    const autoThread = yield* projections.getThread(autoId);
    const autoSettled = yield* orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("g6:auto:settle"),
      threadId: autoId,
      snapshotAt: autoThread.updatedAt,
      settledAt: yield* DateTime.now,
    });
    assert.isTrue(
      autoSettled.storedEvents.some((stored) => stored.event.type === "thread.settled"),
    );
    assert.equal(feature.apply(autoSettled.storedEvents).transitions, 1);
    assert.equal(feature.citizens.get(autoId)?.epoch, 1);
    assert.isTrue(feature.citizens.get(autoId)!.closed);

    const deletedId = ThreadId.make("thread:g6:deleted");
    feature.apply(
      (yield* orchestrator.dispatch(
        createThreadCommand({ commandId: "g6:delete:create", threadId: deletedId }),
      )).storedEvents,
    );
    const deleted = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("g6:delete"),
      threadId: deletedId,
    });
    assert.equal(deleted.storedEvents[0]?.event.type, "thread.deleted");
    assert.equal(feature.apply(deleted.storedEvents).transitions, 1);
    assert.deepEqual(
      {
        epoch: feature.citizens.get(deletedId)?.epoch,
        closed: feature.citizens.get(deletedId)?.closed,
        deleted: feature.citizens.get(deletedId)?.deleted,
      },
      { epoch: 1, closed: true, deleted: true },
    );
    assert.equal(feature.apply(deleted.storedEvents).applied, 0);
  }).pipe(Effect.provide(layerProbe)),
);
