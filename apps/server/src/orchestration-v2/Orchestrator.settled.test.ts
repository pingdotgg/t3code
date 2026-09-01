import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { layer as mcpSessionRegistryTestLayer } from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-settled-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by settle tests"),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: {} as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestProviderInstanceRegistry = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
  listInstances: Effect.succeed([providerInstance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const VcsDriverRegistryTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistryTestLayer),
);

const TestLayer = Layer.merge(OrchestrationV2LayerLive, OrchestrationV2EventSinkLayerLive).pipe(
  Layer.provide(mcpSessionRegistryTestLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(TestProviderInstanceRegistry),
  Layer.provide(NodeServices.layer),
);

function createThreadCommand(input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  return {
    type: "thread.create" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    commandId: CommandId.make(input.commandId),
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Settled lifecycle thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
  };
}

function makeRun(input: {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId | null;
}): OrchestrationV2Run {
  return {
    id: input.runId,
    threadId: input.threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: MessageId.make(`message:${input.runId}`),
    rootNodeId: NodeId.make(`node:${input.runId}`),
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.status === "queued" || input.status === "preparing" ? null : input.now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.status === "queued" ? { queuePosition: 1 } : {}),
  };
}

function makeProviderThread(input: {
  readonly id: ProviderThreadId;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly pendingBackgroundTasks?: OrchestrationV2ProviderThread["pendingBackgroundTasks"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.id,
    driver,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: String(input.id),
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: input.pendingBackgroundTasks ?? [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makeProviderChildThread(input: {
  readonly parent: OrchestrationV2AppThread;
  readonly childThreadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    ...input.parent,
    id: input.childThreadId,
    title: `Provider child ${input.childThreadId}`,
    createdBy: "agent",
    creationSource: "provider",
    activeProviderThreadId: input.providerThreadId,
    lineage: {
      parentThreadId: input.parent.id,
      relationshipToParent: "subagent",
      rootThreadId: input.parent.lineage.rootThreadId,
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makeProviderChildTurn(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly nodeId: NodeId;
  readonly now: DateTime.Utc;
  readonly status: OrchestrationV2ProviderTurn["status"];
}): OrchestrationV2ProviderTurn {
  return {
    id: input.providerTurnId,
    providerThreadId: input.providerThreadId,
    nodeId: input.nodeId,
    runAttemptId: null,
    nativeTurnRef: {
      driver,
      nativeId: String(input.providerTurnId),
      strength: "weak",
    },
    ordinal: 1,
    status: input.status,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
  };
}

function makeProviderNativeSubagent(input: {
  readonly parentThreadId: ThreadId;
  readonly parentNodeId: NodeId;
  readonly runId?: RunId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly childThreadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly status: OrchestrationV2Subagent["status"];
}): OrchestrationV2Subagent {
  return {
    id: input.parentNodeId,
    threadId: input.parentThreadId,
    runId: input.runId ?? null,
    parentNodeId: input.parentNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: modelSelection.instanceId,
    providerThreadId: input.providerThreadId,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver,
      nativeId: String(input.parentNodeId),
      strength: "strong",
    },
    prompt: "Run the background task.",
    title: null,
    model: modelSelection.model,
    status: input.status,
    result: null,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    updatedAt: input.now,
  };
}

it.layer(TestLayer)("OrchestratorV2 provider-native Stop invariants", (it) => {
  it.effect("interrupts only running direct provider-native children and de-duplicates races", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.makeUnsafe("2026-07-31T12:00:00.000Z");
      const parentThreadId = ThreadId.make("thread:provider-native-stop-parent");
      const projectId = ProjectId.make("project:provider-native-stop");

      yield* orchestrator.dispatch(
        createThreadCommand({
          commandId: "cmd:provider-native-stop:create",
          threadId: parentThreadId,
          projectId,
        }),
      );
      const parent = (yield* orchestrator.getThreadProjection(parentThreadId)).thread;

      const makeChild = (
        label: string,
        status: OrchestrationV2ProviderTurn["status"],
        subagentStatus: OrchestrationV2Subagent["status"],
        childParent: OrchestrationV2AppThread = parent,
        runId: RunId | null = null,
      ) => {
        const childThreadId = ThreadId.make(`thread:provider-native-stop:${label}`);
        const providerThreadId = ProviderThreadId.make(
          `provider-thread:provider-native-stop:${label}`,
        );
        const providerTurnId = ProviderTurnId.make(`provider-turn:provider-native-stop:${label}`);
        const nodeId = NodeId.make(`node:provider-native-stop:${label}`);
        const childThread = makeProviderChildThread({
          parent: childParent,
          childThreadId,
          providerThreadId,
          now,
        });
        const providerThread = {
          ...makeProviderThread({
            id: providerThreadId,
            threadId: childThreadId,
            now,
          }),
          providerSessionId: ProviderSessionId.make(
            `provider-session:provider-native-stop:${label}`,
          ),
          ownerNodeId:
            childParent.id === parent.id
              ? nodeId
              : NodeId.make(`node:provider-native-stop:${childParent.id}:owner`),
          status: status === "running" ? ("active" as const) : ("idle" as const),
          appThreadId: childThreadId,
        };
        const providerTurn = makeProviderChildTurn({
          providerThreadId,
          providerTurnId,
          nodeId,
          now,
          status,
        });
        const subagent = makeProviderNativeSubagent({
          parentThreadId: childParent.id,
          parentNodeId: nodeId,
          providerThreadId,
          childThreadId,
          now,
          status: subagentStatus,
          runId,
        });
        return { childThread, providerThread, providerTurn, subagent };
      };

      const rolledBackSpawnRunId = RunId.make("run:provider-native-stop:rolled-back-spawn");
      const first = makeChild("first", "running", "running", parent, rolledBackSpawnRunId);
      const second = makeChild("second", "running", "running");
      const terminal = makeChild("terminal", "completed", "completed");
      const nested = makeChild("nested", "running", "running", first.childThread);
      const missingProviderRow = makeChild("stale-missing-provider-row", "running", "running");
      const nullProviderSession = makeChild("stale-null-provider-session", "running", "running");
      const nullProviderSessionThread = {
        ...nullProviderSession.providerThread,
        providerSessionId: null,
      };
      const staleNullProviderThread: OrchestrationV2Subagent = {
        ...first.subagent,
        id: NodeId.make("node:provider-native-stop:stale-null-provider-thread"),
        parentNodeId: NodeId.make("node:provider-native-stop:stale-null-provider-thread"),
        providerThreadId: null,
        childThreadId: terminal.childThread.id,
      };
      const staleMissingChild: OrchestrationV2Subagent = {
        ...first.subagent,
        id: NodeId.make("node:provider-native-stop:stale-missing-child"),
        parentNodeId: NodeId.make("node:provider-native-stop:stale-missing-child"),
        childThreadId: ThreadId.make("thread:provider-native-stop:stale-missing-child"),
      };
      const staleNoRunningTurn: OrchestrationV2Subagent = {
        ...terminal.subagent,
        id: NodeId.make("node:provider-native-stop:stale-no-running-turn"),
        parentNodeId: NodeId.make("node:provider-native-stop:stale-no-running-turn"),
        status: "running",
        completedAt: null,
        updatedAt: now,
      };
      const nestedOnTerminal: OrchestrationV2Subagent = {
        ...nested.subagent,
        id: NodeId.make("node:provider-native-stop:terminal-nested"),
        threadId: terminal.childThread.id,
        parentNodeId: terminal.providerTurn.nodeId,
      };
      const seededEvents: Array<OrchestrationV2DomainEvent> = [];
      seededEvents.push({
        id: EventId.make("event:provider-native-stop:rolled-back-spawn"),
        type: "run.created",
        threadId: parentThreadId,
        runId: rolledBackSpawnRunId,
        nodeId: NodeId.make("node:provider-native-stop:rolled-back-spawn"),
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: makeRun({
          runId: rolledBackSpawnRunId,
          threadId: parentThreadId,
          status: "rolled_back",
          now,
        }),
      });
      for (const child of [
        first,
        second,
        terminal,
        nested,
        nullProviderSession,
        missingProviderRow,
      ]) {
        seededEvents.push({
          id: EventId.make(`event:provider-native-stop:${child.childThread.id}:created`),
          type: "thread.created",
          threadId: child.childThread.id,
          occurredAt: now,
          payload: child.childThread,
        });
      }
      for (const child of [first, second, terminal, nested]) {
        seededEvents.push({
          id: EventId.make(`event:provider-native-stop:${child.providerThread.id}:updated`),
          type: "provider-thread.updated",
          threadId: child.childThread.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: child.providerThread,
        });
        seededEvents.push({
          id: EventId.make(`event:provider-native-stop:${child.providerTurn.id}:updated`),
          type: "provider-turn.updated",
          threadId: child.childThread.id,
          nodeId: child.providerTurn.nodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: child.providerTurn,
        });
      }
      seededEvents.push({
        id: EventId.make(`event:provider-native-stop:${nullProviderSessionThread.id}:updated`),
        type: "provider-thread.updated",
        threadId: nullProviderSession.childThread.id,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: nullProviderSessionThread,
      });
      seededEvents.push({
        id: EventId.make(
          `event:provider-native-stop:${nullProviderSession.providerTurn.id}:updated`,
        ),
        type: "provider-turn.updated",
        threadId: nullProviderSession.childThread.id,
        nodeId: nullProviderSession.providerTurn.nodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: nullProviderSession.providerTurn,
      });
      seededEvents.push({
        id: EventId.make(
          `event:provider-native-stop:${missingProviderRow.providerTurn.id}:updated`,
        ),
        type: "provider-turn.updated",
        threadId: missingProviderRow.childThread.id,
        nodeId: missingProviderRow.providerTurn.nodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: missingProviderRow.providerTurn,
      });
      for (const subagent of [
        first.subagent,
        second.subagent,
        terminal.subagent,
        staleNullProviderThread,
        staleMissingChild,
        staleNoRunningTurn,
        missingProviderRow.subagent,
        nullProviderSession.subagent,
      ]) {
        seededEvents.push({
          id: EventId.make(`event:provider-native-stop:${subagent.id}:subagent`),
          type: "subagent.updated",
          threadId: parentThreadId,
          nodeId: subagent.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: subagent,
        });
      }
      seededEvents.push({
        id: EventId.make(`event:provider-native-stop:${nested.subagent.id}:subagent`),
        type: "subagent.updated",
        threadId: first.childThread.id,
        nodeId: nested.subagent.id,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: nested.subagent,
      });
      seededEvents.push({
        id: EventId.make(`event:provider-native-stop:${nestedOnTerminal.id}:subagent`),
        type: "subagent.updated",
        threadId: terminal.childThread.id,
        nodeId: nestedOnTerminal.id,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: nestedOnTerminal,
      });
      yield* eventSink.write({ events: seededEvents });

      const terminalChildProjection = yield* orchestrator.getThreadProjection(
        terminal.childThread.id,
      );
      const terminalChildFullShell = threadShellFromProjection(terminalChildProjection);
      const terminalChildSqlShell = yield* orchestrator.getThreadShell(terminal.childThread.id);
      assert.isTrue(terminalChildFullShell.hasInterruptibleProviderNativeBackgroundWork);
      assert.equal(
        terminalChildSqlShell?.hasInterruptibleProviderNativeBackgroundWork,
        terminalChildFullShell.hasInterruptibleProviderNativeBackgroundWork,
        "SQL and full projections must expose directly-owned nested provider-native work",
      );
      const nestedOnlyDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:terminal-nested"),
        threadId: terminal.childThread.id,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        nestedOnlyDispatch.storedEvents
          .filter((stored) => stored.event.type === "provider-turn.interrupt-requested")
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          ),
        [nested.providerTurn.id],
      );
      const firstChildProjection = yield* orchestrator.getThreadProjection(first.childThread.id);
      const firstChildFullShell = threadShellFromProjection(firstChildProjection);
      const firstChildSqlShell = yield* orchestrator.getThreadShell(first.childThread.id);
      assert.isTrue(firstChildFullShell.hasInterruptibleProviderNativeBackgroundWork);
      assert.equal(
        firstChildSqlShell?.hasInterruptibleProviderNativeBackgroundWork,
        firstChildFullShell.hasInterruptibleProviderNativeBackgroundWork,
        "a provider-native child owns its own running provider turn",
      );

      const parentShell = yield* orchestrator.getThreadShell(parentThreadId);
      assert.isTrue(parentShell?.hasInterruptibleProviderNativeBackgroundWork);

      const firstCommandId = CommandId.make("cmd:provider-native-stop:first");
      const firstDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: firstCommandId,
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        firstDispatch.storedEvents
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          )
          .filter((providerTurnId): providerTurnId is ProviderTurnId => providerTurnId !== null),
        [first.providerTurn.id, second.providerTurn.id],
      );
      for (const stored of firstDispatch.storedEvents) {
        if (stored.event.type !== "provider-turn.interrupt-requested") continue;
        assert.equal(stored.event.threadId, parentThreadId);
        assert.equal(stored.event.nodeId, undefined);
      }
      const firstEffects = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id
        FROM orchestration_v2_effect_outbox
        WHERE command_id = ${firstCommandId}
        ORDER BY effect_id ASC
      `;
      assert.deepEqual(
        firstEffects.map((effect) => effect.effect_id),
        [
          `effect:${firstCommandId}:provider-turn.interrupt:${first.providerTurn.id}`,
          `effect:${firstCommandId}:provider-turn.interrupt:${second.providerTurn.id}`,
        ],
      );

      const replayDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: firstCommandId,
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.deepEqual(replayDispatch.storedEvents, firstDispatch.storedEvents);
      const replayEffects = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id
        FROM orchestration_v2_effect_outbox
        WHERE command_id = ${firstCommandId}
        ORDER BY effect_id ASC
      `;
      assert.deepEqual(replayEffects, firstEffects);

      const retryCommandId = CommandId.make("cmd:provider-native-stop:retry");
      const retryDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: retryCommandId,
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.equal(
        retryDispatch.storedEvents.filter(
          (stored) => stored.event.type === "provider-turn.interrupt-requested",
        ).length,
        2,
      );
      const retryEffects = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id
        FROM orchestration_v2_effect_outbox
        WHERE command_id = ${retryCommandId}
        ORDER BY effect_id ASC
      `;
      assert.deepEqual(
        retryEffects.map((effect) => effect.effect_id),
        [
          `effect:${retryCommandId}:provider-turn.interrupt:${first.providerTurn.id}`,
          `effect:${retryCommandId}:provider-turn.interrupt:${second.providerTurn.id}`,
        ],
      );

      const missingProviderInstanceId = ProviderInstanceId.make("provider-native-stop-missing");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:provider-native-stop:second:unresolvable"),
            type: "provider-thread.updated",
            threadId: second.childThread.id,
            providerInstanceId: missingProviderInstanceId,
            occurredAt: now,
            payload: { ...second.providerThread, providerInstanceId: missingProviderInstanceId },
          },
        ],
      });
      const atomicFailureCommandId = CommandId.make("cmd:provider-native-stop:atomic-failure");
      const atomicFailure = yield* orchestrator
        .dispatch({
          type: "run.interrupt",
          commandId: atomicFailureCommandId,
          threadId: parentThreadId,
          intent: "provider_native_only",
        })
        .pipe(Effect.flip);
      assert.equal(atomicFailure._tag, "OrchestratorProviderAdapterError");
      const atomicEffects = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id
        FROM orchestration_v2_effect_outbox
        WHERE command_id = ${atomicFailureCommandId}
      `;
      assert.deepEqual(atomicEffects, []);

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:provider-native-stop:second:restored"),
            type: "provider-thread.updated",
            threadId: second.childThread.id,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: second.providerThread,
          },
        ],
      });
      const afterFailedCommandId = CommandId.make("cmd:provider-native-stop:after-failed");
      const afterFailedDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: afterFailedCommandId,
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        afterFailedDispatch.storedEvents
          .filter((stored) => stored.event.type === "provider-turn.interrupt-requested")
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          ),
        [first.providerTurn.id, second.providerTurn.id],
      );
      const afterFailedEffects = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id
        FROM orchestration_v2_effect_outbox
        WHERE command_id = ${afterFailedCommandId}
        ORDER BY effect_id ASC
      `;
      assert.deepEqual(
        afterFailedEffects.map((effect) => effect.effect_id),
        [
          `effect:${afterFailedCommandId}:provider-turn.interrupt:${first.providerTurn.id}`,
          `effect:${afterFailedCommandId}:provider-turn.interrupt:${second.providerTurn.id}`,
        ],
      );

      const childDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:child"),
        threadId: first.childThread.id,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        childDispatch.storedEvents
          .filter((stored) => stored.event.type === "provider-turn.interrupt-requested")
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          ),
        [first.providerTurn.id],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:provider-native-stop:first:terminal"),
            type: "provider-turn.updated",
            threadId: first.childThread.id,
            nodeId: first.providerTurn.nodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...first.providerTurn, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make("event:provider-native-stop:first:subagent-terminal"),
            type: "subagent.updated",
            threadId: parentThreadId,
            nodeId: first.subagent.id,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...first.subagent, status: "interrupted", completedAt: now, updatedAt: now },
          },
        ],
      });

      const nestedAfterOwnTurnDispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:child-nested-after-own"),
        threadId: first.childThread.id,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        nestedAfterOwnTurnDispatch.storedEvents
          .filter((stored) => stored.event.type === "provider-turn.interrupt-requested")
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          ),
        [nested.providerTurn.id],
      );

      const afterCompletion = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:after-completion"),
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.deepEqual(
        afterCompletion.storedEvents
          .filter((stored) => stored.event.type === "provider-turn.interrupt-requested")
          .map((stored) =>
            stored.event.type === "provider-turn.interrupt-requested"
              ? stored.event.payload.providerTurnId
              : null,
          ),
        [second.providerTurn.id],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:provider-native-stop:second:terminal"),
            type: "provider-turn.updated",
            threadId: second.childThread.id,
            nodeId: second.providerTurn.nodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...second.providerTurn, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("event:provider-native-stop:second:subagent-terminal"),
            type: "subagent.updated",
            threadId: parentThreadId,
            nodeId: second.subagent.id,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...second.subagent, status: "completed", completedAt: now, updatedAt: now },
          },
        ],
      });
      const noOp = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:no-op"),
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.equal(noOp.storedEvents[0]?.event.type, "run.interrupt-noop");
      if (noOp.storedEvents[0]?.event.type === "run.interrupt-noop") {
        assert.equal(
          noOp.storedEvents[0].event.payload.reason,
          "All provider-native background targets completed before interruption dispatch.",
        );
      }
      const repeatedNoOp = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("cmd:provider-native-stop:no-op-retry"),
        threadId: parentThreadId,
        intent: "provider_native_only",
      });
      assert.equal(repeatedNoOp.storedEvents[0]?.event.type, "run.interrupt-noop");

      const staleSubagents = [
        staleNullProviderThread,
        staleMissingChild,
        staleNoRunningTurn,
        missingProviderRow.subagent,
        nullProviderSession.subagent,
      ];
      yield* eventSink.write({
        events: staleSubagents.map((subagent, index) => ({
          id: EventId.make(`event:provider-native-stop:stale:${index}:terminal`),
          type: "subagent.updated" as const,
          threadId: parentThreadId,
          nodeId: subagent.id,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...subagent,
            status: "interrupted" as const,
            completedAt: now,
            updatedAt: now,
          },
        })),
      });
      const settledParentShell = yield* orchestrator.getThreadShell(parentThreadId);
      assert.isFalse(settledParentShell?.hasInterruptibleProviderNativeBackgroundWork);
    }),
  );

  it.effect(
    "keeps provider-native-only Stop off a root run that appears after the no-run read",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const eventSink = yield* EventSinkV2;
        const parentThreadId = ThreadId.make("thread:provider-native-stop-race-parent");
        const projectId = ProjectId.make("project:provider-native-stop-race");
        const now = DateTime.makeUnsafe("2026-08-01T12:00:00.000Z");

        yield* orchestrator.dispatch(
          createThreadCommand({
            commandId: "cmd:provider-native-stop-race:create",
            threadId: parentThreadId,
            projectId,
          }),
        );
        const parent = (yield* orchestrator.getThreadProjection(parentThreadId)).thread;
        const childThreadId = ThreadId.make("thread:provider-native-stop-race-child");
        const providerThreadId = ProviderThreadId.make("provider-thread:provider-native-stop-race");
        const providerTurnId = ProviderTurnId.make("provider-turn:provider-native-stop-race");
        const nodeId = NodeId.make("node:provider-native-stop-race");
        const childThread = makeProviderChildThread({
          parent,
          childThreadId,
          providerThreadId,
          now,
        });
        const providerThread = {
          ...makeProviderThread({
            id: providerThreadId,
            threadId: childThreadId,
            now,
          }),
          providerSessionId: ProviderSessionId.make("provider-session:provider-native-stop-race"),
          ownerNodeId: nodeId,
          status: "active" as const,
          appThreadId: childThreadId,
        };
        const providerTurn = makeProviderChildTurn({
          providerThreadId,
          providerTurnId,
          nodeId,
          now,
          status: "running",
        });
        const subagent = makeProviderNativeSubagent({
          parentThreadId,
          parentNodeId: nodeId,
          providerThreadId,
          childThreadId,
          now,
          status: "running",
        });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-native-stop-race:thread"),
              type: "thread.created",
              threadId: childThreadId,
              occurredAt: now,
              payload: childThread,
            },
            {
              id: EventId.make("event:provider-native-stop-race:provider-thread"),
              type: "provider-thread.updated",
              threadId: childThreadId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: EventId.make("event:provider-native-stop-race:provider-turn"),
              type: "provider-turn.updated",
              threadId: childThreadId,
              nodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: providerTurn,
            },
            {
              id: EventId.make("event:provider-native-stop-race:subagent"),
              type: "subagent.updated",
              threadId: parentThreadId,
              nodeId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: subagent,
            },
          ],
        });

        const shellBeforeRootRace = yield* orchestrator.getThreadShell(parentThreadId);
        assert.isTrue(shellBeforeRootRace?.hasInterruptibleProviderNativeBackgroundWork);

        const rootRunId = RunId.make("run:provider-native-stop-race-root");
        const rootRun = makeRun({
          runId: rootRunId,
          threadId: parentThreadId,
          status: "running",
          now,
        });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:provider-native-stop-race:root-run"),
              type: "run.created",
              threadId: parentThreadId,
              runId: rootRunId,
              ...(rootRun.rootNodeId === null ? {} : { nodeId: rootRun.rootNodeId }),
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: rootRun,
            },
          ],
        });

        const dispatch = yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("cmd:provider-native-stop-race:dispatch"),
          threadId: parentThreadId,
          intent: "provider_native_only",
        });
        assert.deepEqual(
          dispatch.storedEvents.map((stored) => stored.event.type),
          ["provider-turn.interrupt-requested"],
        );
        assert.isFalse(
          dispatch.storedEvents.some(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "run_interrupt_request",
          ),
        );
      }),
  );
});

it.layer(TestLayer)("OrchestratorV2 settled lifecycle invariants", (it) => {
  it.effect("settles an idle thread and rejects settle while a run is queued", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settle-queued");
      const projectId = ProjectId.make("project:settle-queued");

      yield* orchestrator.dispatch(
        createThreadCommand({
          commandId: "cmd:settle-queued:create",
          threadId,
          projectId,
        }),
      );

      const idleSettle = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd:settle-queued:idle"),
        threadId,
      });
      assert.equal(idleSettle.storedEvents[0]?.event.type, "thread.settled");

      // Unsettle so the next settle attempt is not an idempotent re-emit.
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("cmd:settle-queued:unsettle"),
        threadId,
        reason: "user",
      });

      const runId = RunId.make("run:settle-queued");
      const runEvent = {
        id: EventId.make("event:settle-queued:run"),
        type: "run.created" as const,
        threadId,
        runId,
        nodeId: NodeId.make("node:settle-queued"),
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: makeRun({ runId, threadId, status: "queued", now }),
      } satisfies OrchestrationV2DomainEvent;
      yield* eventSink.write({ events: [runEvent] });

      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd:settle-queued:blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      if (rejected._tag === "OrchestratorDispatchError") {
        assert.match(String(rejected.cause), /queued run/i);
      }

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "active");
    }),
  );

  it.effect("rejects settle while pending background tasks remain on the shell", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const eventSink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settle-background");
      const projectId = ProjectId.make("project:settle-background");
      const providerThreadId = ProviderThreadId.make("provider-thread:settle-background");
      const runId = RunId.make("run:settle-background");

      yield* orchestrator.dispatch(
        createThreadCommand({
          commandId: "cmd:settle-background:create",
          threadId,
          projectId,
        }),
      );

      const created = yield* orchestrator.getThreadProjection(threadId);
      // Terminal latest run + non-empty background roster on the active
      // provider thread: shell is waiting and must not settle.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:settle-background:run"),
            type: "run.created",
            threadId,
            runId,
            nodeId: NodeId.make("node:settle-background"),
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...makeRun({
                runId,
                threadId,
                status: "completed",
                now,
                providerThreadId,
              }),
              completedAt: now,
            },
          },
          {
            id: EventId.make("event:settle-background:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: makeProviderThread({
              id: providerThreadId,
              threadId,
              now,
              pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 30" }],
            }),
          },
          {
            id: EventId.make("event:settle-background:pin-active-provider"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...created.thread,
              activeProviderThreadId: providerThreadId,
              updatedAt: now,
            },
          },
        ],
      });

      const rejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("cmd:settle-background:blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "OrchestratorDispatchError");
      if (rejected._tag === "OrchestratorDispatchError") {
        assert.match(String(rejected.cause), /background tasks/i);
      }
    }),
  );
});
