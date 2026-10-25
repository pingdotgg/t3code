import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Etag, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const decodeBounded = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeStreamItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const projectId = ProjectId.make("project:compact-transport");
const PARENT = ThreadId.make("thread:compact-transport:parent");
const FORK = ThreadId.make("thread:compact-transport:fork");
const LONG = ThreadId.make("thread:compact-transport:long");
const BODIES = ThreadId.make("thread:compact-transport:bodies");
const parentRun = RunId.make("run:compact-transport:parent");
const longRun = RunId.make("run:compact-transport:long");
const bodiesRun = RunId.make("run:compact-transport:bodies");

const store = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      streamStoredEventsFrom: (input) =>
        input?.threadId === BODIES ? Stream.fromIterable(bodiesLiveTail()) : Stream.empty,
    });
  }),
);

class OrchestrationApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("compact-transport"),
      subject: "compact-transport",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);

function threadCreated(id: ThreadId, at: DateTime.Utc, forkOf?: RunId): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId,
      title: String(id),
      providerInstanceId: provider,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        forkOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : { parentThreadId: PARENT, relationshipToParent: "fork", rootThreadId: PARENT },
      forkedFrom: forkOf === undefined ? null : { type: "run", threadId: PARENT, runId: forkOf },
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function runCreated(
  threadId: ThreadId,
  runId: RunId,
  at: DateTime.Utc,
): OrchestrationV2DomainEvent {
  const rootNodeId = NodeId.make(`node:${runId}`);
  return {
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver: ProviderDriverKind.make("codex"),
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: provider,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function itemUpdated(
  threadId: ThreadId,
  runId: RunId | null,
  key: string,
  ordinal: number,
  at: DateTime.Utc,
  type:
    | "command_execution"
    | "run_interrupt_request"
    | "run_interrupt_result" = "command_execution",
): OrchestrationV2DomainEvent {
  const base = {
    id: TurnItemId.make(`turn-item:${threadId}:${key}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: key,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const payload: OrchestrationV2TurnItem =
    type === "command_execution"
      ? { ...base, type, input: `echo ${key}`, output: `output ${key}`, exitCode: 0 }
      : { ...base, type, message: key };
  return {
    id: EventId.make(`event:${threadId}:${key}`),
    type: "turn-item.updated",
    threadId,
    ...(runId === null ? {} : { runId }),
    occurredAt: at,
    payload,
  };
}

// A conversation turn whose records (message, checkpoint, subagent) repeat in its turn items.
function bodiesEvents(at: DateTime.Utc): OrchestrationV2DomainEvent[] {
  const event = (key: string, rest: Pick<OrchestrationV2DomainEvent, "type" | "payload">) =>
    ({
      id: EventId.make(`event:${BODIES}:${key}`),
      threadId: BODIES,
      runId: bodiesRun,
      occurredAt: at,
      ...rest,
    }) as OrchestrationV2DomainEvent;
  const item = (key: string, ordinal: number, fields: object) =>
    event(`${key}-item`, {
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`turn-item:${BODIES}:${key}`),
        threadId: BODIES,
        runId: bodiesRun,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        ...fields,
      } as OrchestrationV2TurnItem,
    });
  const message = (key: string, role: "user" | "assistant", text: string) =>
    event(`${key}-message`, {
      type: "message.updated",
      payload: {
        id: MessageId.make(`message:${key === "prompt" ? bodiesRun : `${BODIES}:${key}`}`),
        threadId: BODIES,
        runId: bodiesRun,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
  const files = [{ path: "src/index.ts", kind: "modified", additions: 4, deletions: 2 }];
  return [
    threadCreated(BODIES, at),
    runCreated(BODIES, bodiesRun, at),
    message("prompt", "user", "Please fix the build."),
    item("prompt", 1, {
      type: "user_message",
      messageId: MessageId.make(`message:${bodiesRun}`),
      inputIntent: "turn_start",
      text: "Please fix the build.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    }),
    event("task-record", { type: "subagent.updated", payload: bodiesSubagent(at) }),
    item("task", 2, {
      type: "subagent",
      subagentId: bodiesSubagent(at).id,
      origin: "app_owned",
      driver: "codex",
      providerInstanceId: provider,
      childThreadId: null,
      prompt: bodiesSubagent(at).prompt,
      result: bodiesSubagent(at).result,
    }),
    message("reply", "assistant", "Fixed the import."),
    item("reply", 3, {
      type: "assistant_message",
      messageId: MessageId.make(`message:${BODIES}:reply`),
      text: "Fixed the import.",
      streaming: false,
    }),
    event("checkpoint-record", {
      type: "checkpoint.captured",
      payload: {
        id: CheckpointId.make(`checkpoint:${BODIES}`),
        threadId: BODIES,
        scopeId: CheckpointScopeId.make(`scope:${BODIES}`),
        runId: bodiesRun,
        nodeId: NodeId.make(`node:${bodiesRun}`),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make(`refs/t3/${BODIES}`),
        status: "ready",
        files,
        capturedAt: at,
      },
    }),
    item("checkpoint", 4, {
      type: "checkpoint",
      checkpointId: CheckpointId.make(`checkpoint:${BODIES}`),
      scopeId: CheckpointScopeId.make(`scope:${BODIES}`),
      files,
    }),
  ];
}

function bodiesSubagent(at: DateTime.Utc): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`node:${BODIES}:task`),
    threadId: BODIES,
    runId: bodiesRun,
    parentNodeId: NodeId.make(`node:${bodiesRun}`),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: provider,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Find the failing import.",
    title: null,
    model: null,
    status: "completed",
    result: "It was src/index.ts.",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

// Live after the snapshot: a reply pair, then a subagent update that repeats its prompt.
function bodiesLiveTail(): OrchestrationV2StoredEvent[] {
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const [reply, replyItem] = bodiesEvents(at).filter((event) =>
    String(event.id).includes(":reply-"),
  );
  return [
    reply!,
    replyItem!,
    {
      id: EventId.make(`event:${BODIES}:task-progress`),
      type: "subagent.updated",
      threadId: BODIES,
      runId: bodiesRun,
      occurredAt: at,
      payload: { ...bodiesSubagent(at), progress: "Checked the build." },
    } as OrchestrationV2DomainEvent,
  ].map((event, index) => ({ sequence: 1_000 + index, commandId: null, event }));
}

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = [
    threadCreated(PARENT, at),
    runCreated(PARENT, parentRun, at),
    ...[1, 2, 3].map((n) => itemUpdated(PARENT, parentRun, `parent-${n}`, n, at)),
    threadCreated(FORK, at, parentRun),
    ...[1, 2, 3, 4].map((n) => itemUpdated(FORK, null, `fork-${n}`, n, at)),
    threadCreated(LONG, at),
    runCreated(LONG, longRun, at),
    itemUpdated(LONG, longRun, "request", 1, at, "run_interrupt_request"),
    ...Array.from({ length: 90 }, (_, index) =>
      itemUpdated(LONG, longRun, `tool-${index}`, index + 2, at),
    ),
    itemUpdated(LONG, longRun, "result", 92, at, "run_interrupt_result"),
    ...bodiesEvents(at),
  ];
  for (const event of events) yield* projections.apply(event);
});

const TestLayer = Layer.mergeAll(
  management,
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("compact-transport")),
  }),
  Layer.effectDiscard(seed),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
).pipe(Layer.provideMerge(store));

const withHttp = <A>(use: (get: (path: string) => Promise<Response>) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof TestLayer>>();
    const appLayer = HttpApiBuilder.layer(OrchestrationApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          use((path) =>
            handler(
              new Request(`http://environment.test${path}`, {
                headers: {
                  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                },
              }),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

const firstSnapshot = (input: Parameters<typeof subscribeOrchestrationV2Thread>[0]) =>
  subscribeOrchestrationV2Thread(input).pipe(
    Effect.flatMap((stream) => Stream.runHead(stream)),
    Effect.map((head) => {
      if (head._tag !== "Some" || head.value.kind !== "snapshot") throw new Error("No snapshot");
      const decoded = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(head.value))));
      if (decoded.kind !== "snapshot") throw new Error("No snapshot");
      return { raw: head.value, decoded };
    }),
  );

function itemIds(projection: OrchestrationV2ThreadProjection): string[] {
  return projection.turnItems.map((item) => String(item.id));
}

it.layer(TestLayer)("compact bounded snapshot transport", (it) => {
  describe.each([
    ["fork", FORK],
    ["long run with a retained interrupt request", LONG],
  ])("%s", (_, threadId) => {
    it.effect("HTTP: legacy, ignored and opted-in requests restore to the same snapshot", () =>
      withHttp(async (get) => {
        const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`;
        const legacyBody = await (await get(base)).text();
        const ignoredBody = await (await get(`${base}?compactTurnItems=yes&unknown=1`)).text();
        const compactResponse = await get(`${base}?compactTurnItems=1`);
        assert.strictEqual(compactResponse.status, 200);
        const compactBody = await compactResponse.text();

        assert.notInclude(legacyBody, "turnItemsOmitLocalVisible");
        assert.strictEqual(ignoredBody, legacyBody);
        assert.isBelow(compactBody.length, legacyBody.length);

        const legacy = decodeBounded(legacyBody);
        const compact = decodeBounded(compactBody);
        assert.isTrue(compact.turnItemsOmitLocalVisible);
        const { turnItemsOmitLocalVisible: _marker, projection: _p, ...compactRest } = compact;
        const { projection: _legacyProjection, ...legacyRest } = legacy;
        assert.deepStrictEqual(compactRest, legacyRest);
        assert.deepStrictEqual(boundedSnapshotProjection(compact), legacy.projection);
        return { legacy, compact };
      }).pipe(
        Effect.tap(({ legacy }) =>
          Effect.sync(() => {
            if (threadId === FORK) {
              const visibility = legacy.projection.visibleTurnItems.map((row) => row.visibility);
              assert.deepStrictEqual(visibility, [
                "inherited",
                "inherited",
                "inherited",
                "synthetic",
                "local",
                "local",
                "local",
                "local",
              ]);
            } else {
              const ids = itemIds(legacy.projection);
              assert.isTrue(legacy.hasMoreHistory);
              assert.strictEqual(ids.at(-1), `turn-item:${LONG}:request`);
              assert.isFalse(
                legacy.projection.visibleTurnItems.some((row) => row.sourceItemId === ids.at(-1)),
              );
            }
          }),
        ),
      ),
    );

    it.effect("WS: bounded snapshots stay unchanged unless the client opts in", () =>
      Effect.gen(function* () {
        const legacy = yield* firstSnapshot({ threadId, acceptBoundedSnapshot: true });
        const compact = yield* firstSnapshot({
          threadId,
          acceptBoundedSnapshot: true,
          acceptCompactTurnItems: true,
        });
        const full = yield* firstSnapshot({ threadId, acceptCompactTurnItems: true });

        assert.isUndefined(legacy.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.turnItemsOmitLocalVisible);
        assert.isUndefined(full.decoded.historyCursor);
        assert.isTrue(compact.decoded.turnItemsOmitLocalVisible);
        assert.isBelow(
          compact.decoded.projection.turnItems.length,
          legacy.decoded.projection.turnItems.length,
        );
        assert.deepStrictEqual(
          boundedSnapshotProjection(compact.decoded),
          legacy.decoded.projection,
        );
        assert.deepStrictEqual(
          {
            ...compact.decoded,
            projection: legacy.decoded.projection,
            turnItemsOmitLocalVisible: undefined,
          },
          { ...legacy.decoded, turnItemsOmitLocalVisible: undefined },
        );
      }),
    );
  });

  describe("deduped bodies", () => {
    const markers = ["textOmitted", "filesOmitted", "promptOmitted", "resultOmitted"];

    it.effect(
      "HTTP: opted-in snapshots blank repeated bodies and restore to the same snapshot",
      () =>
        withHttp(async (get) => {
          const base = `/api/orchestration/threads/${encodeURIComponent(BODIES)}/bounded`;
          const compactBody = await (await get(`${base}?compactTurnItems=1`)).text();
          const dedupedBody = await (await get(`${base}?compactTurnItems=1&dedupeBodies=1`)).text();

          for (const marker of markers) {
            assert.notInclude(compactBody, marker);
            assert.include(dedupedBody, marker);
          }
          assert.isBelow(dedupedBody.length, compactBody.length);
          assert.deepStrictEqual(
            boundedSnapshotProjection(decodeBounded(dedupedBody)),
            boundedSnapshotProjection(decodeBounded(compactBody)),
          );
        }),
    );

    it.effect(
      "WS: bounded and full snapshots restore, and the live tail sends each body once",
      () =>
        Effect.gen(function* () {
          const subscribe = (
            input: Partial<Parameters<typeof subscribeOrchestrationV2Thread>[0]>,
          ) =>
            subscribeOrchestrationV2Thread({ threadId: BODIES, ...input }).pipe(
              Effect.flatMap(Stream.runCollect),
              Effect.map((items) =>
                Array.from(items, (item) =>
                  decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(item)))),
                ),
              ),
            );
          const bounded = { acceptBoundedSnapshot: true, acceptCompactTurnItems: true };
          for (const mode of [bounded, {}]) {
            const [plainSnapshot, ...plainTail] = yield* subscribe(mode);
            const [dedupedSnapshot, ...dedupedTail] = yield* subscribe({
              ...mode,
              acceptDedupedBodies: true,
            });
            if (plainSnapshot?.kind !== "snapshot" || dedupedSnapshot?.kind !== "snapshot") {
              throw new Error("No snapshot");
            }
            assert.deepStrictEqual(
              boundedSnapshotProjection(dedupedSnapshot),
              boundedSnapshotProjection(plainSnapshot),
            );
            const payloads = (tail: typeof plainTail) =>
              tail.map((item) => (item.kind === "event" ? item.event.payload : null));
            const [reply, replyItem, progress] = payloads(plainTail);
            assert.deepStrictEqual(payloads(dedupedTail), [
              reply,
              { ...replyItem, text: "", textOmitted: true },
              // The snapshot delivered this subagent's record, so its unchanged bodies repeat.
              { ...progress, prompt: "", promptOmitted: true, result: null, resultOmitted: true },
            ]);
          }
        }),
    );
  });
});
