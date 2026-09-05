import { assert, it } from "@effect/vitest";
import {
  EventId,
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
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
  layer,
  layerMemory,
} from "./ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  layer as controlLayer,
  ProviderTurnControlServiceV2,
} from "./ProviderTurnControlService.ts";
import { layer as replyLayer, RuntimeRequestServiceV2 } from "./RuntimeRequestService.ts";

const threadId = ThreadId.make("thread:control-reads");
const providerThreadId = ProviderThreadId.make("provider-thread:control-reads");
const providerTurnId = ProviderTurnId.make("provider-turn:control-reads");
const providerSessionId = ProviderSessionId.make("session:control-reads");
const attemptId = RunAttemptId.make("attempt:control-reads");
const runId = RunId.make("run:control-reads");
const messageId = MessageId.make("message:control-reads");
const requestId = RuntimeRequestId.make("request:control-reads");
const nodeId = NodeId.make("node:control-reads");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };

function fixtureEvents(now: DateTime.Utc): ReadonlyArray<OrchestrationV2DomainEvent> {
  const common = { threadId, occurredAt: now };
  return [
    {
      ...common,
      id: EventId.make("control:thread"),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:control-reads"),
        title: "Control reads",
        providerInstanceId,
        modelSelection,
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:provider-thread"),
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-control-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...common,
      id: EventId.make("control:run"),
      type: "run.created",
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:attempt"),
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:turn"),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "native-control-turn", strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...common,
      id: EventId.make("control:message"),
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Use the smaller fix.",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...common,
      id: EventId.make("control:request"),
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: now,
      },
    },
  ];
}

for (const storage of ["sqlite", "memory"] as const) {
  const storeLayer =
    storage === "sqlite" ? layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)) : layerMemory;
  it.effect(`${storage}: controls and replies read only their exact durable targets`, () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const events = fixtureEvents(now);
      yield* Effect.forEach(events, (event) => store.apply(event), { discard: true });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message:unrelated-obsolete', ${threadId}, ${runId}, ${nodeId}, 'assistant', 0,
          ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":"transcript"}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const target = { providerThreadId, providerTurnId, attemptId, messageId };
      const context = yield* store.getProviderControlContext(threadId, target);
      assert.equal(context.providerThread?.id, providerThreadId);
      assert.equal(context.providerTurn?.id, providerTurnId);
      assert.equal(context.attempt?.id, attemptId);
      assert.equal(context.message?.text, "Use the smaller fix.");
      assert.equal(context.run?.id, runId);
      assert.equal((yield* store.getRuntimeRequest(threadId, requestId))?.status, "resolved");
      assert.isUndefined(
        yield* store.getRuntimeRequest(threadId, RuntimeRequestId.make("request:missing")),
      );
      const absent = yield* store.getProviderControlContext(threadId, {
        providerThreadId: ProviderThreadId.make("provider-thread:missing"),
        providerTurnId: ProviderTurnId.make("provider-turn:missing"),
      });
      assert.isUndefined(absent.providerThread);
      assert.isUndefined(absent.providerTurn);
      const missingThread = yield* store
        .getRuntimeRequest(ThreadId.make("thread:missing"), requestId)
        .pipe(Effect.flip);
      assert.instanceOf(missingThread, ProjectionStoreThreadNotFoundError);

      const calls: string[] = [];
      const sessions = Layer.mock(ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              interruptTurn: () =>
                Effect.sync(() => {
                  calls.push("interrupt");
                }),
              steerTurn: (input: { message: { text: string }; runId: RunId }) =>
                Effect.sync(() => {
                  assert.equal(input.runId, runId);
                  calls.push(input.message.text);
                }),
              respondToRuntimeRequest: () =>
                Effect.sync(() => {
                  calls.push("reply");
                }),
            } as never),
          ),
      });
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlServiceV2;
        const reply = yield* RuntimeRequestServiceV2;
        yield* control.interrupt({ threadId, providerThreadId, providerTurnId, providerSessionId });
        yield* control.steer({
          threadId,
          providerThreadId,
          providerTurnId,
          providerSessionId,
          messageId,
        });
        yield* reply.respond({ threadId, providerSessionId, requestId, decision: "accept" });
        assert.deepEqual(calls, ["interrupt", "Use the smaller fix.", "reply"]);
        const wrongSession = ProviderSessionId.make("session:wrong");
        assert.equal(
          (yield* Effect.exit(
            control.interrupt({
              threadId,
              providerThreadId,
              providerTurnId,
              providerSessionId: wrongSession,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            reply.respond({
              threadId,
              providerSessionId: wrongSession,
              requestId,
              decision: "accept",
            }),
          ))._tag,
          "Failure",
        );
        assert.lengthOf(calls, 3);
      }).pipe(Effect.provide(Layer.merge(controlLayer, replyLayer).pipe(Layer.provide(sessions))));
    }).pipe(Effect.provide(Layer.merge(storeLayer, SqlitePersistenceMemory))),
  );
}
