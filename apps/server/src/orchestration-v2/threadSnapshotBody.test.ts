import { assert, it } from "@effect/vitest";
import {
  EnvironmentHttpApi,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadDetailSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { encodeThreadSnapshotBody } from "./threadSnapshotBody.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const PARENT = ThreadId.make("thread:snapshot-body:parent");
const FORK = ThreadId.make("thread:snapshot-body:fork");
const parentRun = RunId.make("run:snapshot-body:parent");
const ITEMS = 1_200;
// Escapes, a lone surrogate, astral and two-byte text: every JSON.stringify string rule.
const TEXT = 'quote " slash \\ tab \t nl \n nul \u0000 lone \ud800 astral 𝄞 界';

// What HttpApiBuilder sends: JSON.stringify of the endpoint's own success codec (toCodecJson).
const encodeAsEndpoint = Schema.encodeUnknownSync(
  [...EnvironmentHttpApi.groups.orchestration.endpoints.threadSnapshot.success][0] as Schema.Codec<
    unknown,
    unknown
  >,
);
const referenceBody = (snapshot: OrchestrationV2ThreadDetailSnapshot) =>
  Buffer.from(JSON.stringify(encodeAsEndpoint(snapshot)), "utf8");

const streamedBody = (snapshot: OrchestrationV2ThreadDetailSnapshot) =>
  encodeThreadSnapshotBody(snapshot).pipe(
    Effect.flatMap(Stream.runCollect),
    Effect.map((chunks) => ({
      chunks: chunks.length,
      largestChunk: Math.max(...chunks.map((chunk) => chunk.byteLength)),
      bytes: Buffer.concat([...chunks]),
    })),
  );

const threadCreated = (
  id: ThreadId,
  at: DateTime.Utc,
  forkOf?: RunId,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}:created`),
  type: "thread.created",
  threadId: id,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:snapshot-body"),
    title: `${id} ${TEXT}`,
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
});

const runCreated = (threadId: ThreadId, runId: RunId, at: DateTime.Utc) => {
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
  } satisfies OrchestrationV2DomainEvent;
};

// One item of each wire-projected shape: omitted output, truncated input, a failed diff.
const item = (
  threadId: ThreadId,
  runId: RunId | null,
  ordinal: number,
  at: DateTime.Utc,
): OrchestrationV2DomainEvent => {
  const base = {
    id: TurnItemId.make(`turn-item:${threadId}:${ordinal}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: `${ordinal} ${TEXT}`,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const payloads: ReadonlyArray<OrchestrationV2TurnItem> = [
    {
      ...base,
      type: "command_execution",
      input: `echo ${ordinal} ${TEXT}`,
      output: `${TEXT}\n`.repeat(40),
      exitCode: ordinal % 7 === 0 ? 1 : 0,
    },
    {
      ...base,
      type: "dynamic_tool",
      toolName: "search",
      input: { query: TEXT, pages: Array.from({ length: 900 }, (_, page) => page) },
      output: [{ type: "text", text: TEXT }],
    },
    {
      ...base,
      status: "failed",
      type: "file_change",
      fileName: `src/${ordinal}.ts`,
      diffStr: `@@ ${TEXT}\n`.repeat(20),
    },
    {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`message:${threadId}:${ordinal}`),
      text: TEXT.repeat(3),
      streaming: false,
    },
    // No progress: the wire projection sets it to undefined, which the endpoint sends as null.
    {
      ...base,
      type: "subagent",
      subagentId: NodeId.make(`node:${threadId}:task:${ordinal}`),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: provider,
      childThreadId: null,
      prompt: `Look into ${TEXT}`,
      result: ordinal % 2 === 0 ? null : TEXT,
    },
  ];
  return {
    id: EventId.make(`event:${threadId}:item:${ordinal}`),
    type: "turn-item.updated",
    threadId,
    ...(runId === null ? {} : { runId }),
    occurredAt: at,
    payload: payloads[ordinal % payloads.length]!,
  };
};

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    threadCreated(PARENT, at),
    runCreated(PARENT, parentRun, at),
    ...Array.from({ length: ITEMS }, (_, index) => item(PARENT, parentRun, index + 1, at)),
    // Larger than a chunk, astral throughout, at both offsets: chunks split inside one member.
    ...["", "x"].map((prefix, index) => {
      const event = item(PARENT, parentRun, 1_000 * ITEMS + index * 5, at) as Extract<
        OrchestrationV2DomainEvent,
        { type: "turn-item.updated" }
      >;
      return { ...event, payload: { ...event.payload, input: prefix + "𝄞".repeat(600_000) } };
    }),
    threadCreated(FORK, at, parentRun),
    ...Array.from({ length: 40 }, (_, index) => item(FORK, null, index + 1, at)),
  ];
  for (const event of events) yield* projections.apply(event);
});

const seededStore = <E>(events: Effect.Effect<void, E, ProjectionStore.ProjectionStoreV2>) =>
  Layer.effectDiscard(events).pipe(
    Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provide(NodeCrypto.layerDigest))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const TestLayer = seededStore(seed);

const cycle: Record<string, unknown> = {};
cycle.self = cycle;
const sparse: Array<number> = [];
sparse[2] = 3;
// Values JSON cannot carry, for a field the schema leaves unknown.
const NOT_JSON_VALUES: ReadonlyArray<unknown> = [
  undefined,
  Number.NaN,
  DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  () => 1,
  1n,
  cycle,
  Object("boxed"),
  sparse,
];

const runtimeRequests = (answerSets: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  return answerSets.map((answers, index) => ({
    id: RuntimeRequestId.make(`runtime-request:snapshot-body:${index}`),
    nodeId: NodeId.make(`node:${parentRun}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input" as const,
    status: "resolved" as const,
    responseCapability: { type: "message" as const },
    createdAt: at,
    resolvedAt: at,
    answers,
  }));
};

it.layer(TestLayer)("thread snapshot body", (it) => {
  it.effect("streams a long thread and its fork as the endpoint encodes them", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const threadId of [PARENT, FORK]) {
        const { snapshotSequence, projection } = yield* projections.getThreadSnapshot(threadId);
        const snapshot = {
          snapshotSequence,
          projection: projectThreadProjectionForWire(projection),
        };
        const streamed = yield* streamedBody(snapshot);
        assert.isTrue(streamed.bytes.equals(referenceBody(snapshot)));
        if (threadId === PARENT) {
          assert.strictEqual(snapshot.projection.turnItems.length, ITEMS + 2);
          assert.isTrue(
            snapshot.projection.turnItems.some(
              (item) =>
                item.type === "subagent" && "progress" in item && item.progress === undefined,
            ),
          );
          assert.isAtMost(streamed.largestChunk, 1024 * 1024);
        } else {
          // Inherited rows hold parent items that are not in this thread's turn items.
          assert.isTrue(
            snapshot.projection.visibleTurnItems.some((row) => row.visibility === "inherited"),
          );
        }
      }
    }),
  );

  it.effect("fails before the body when the schema rejects the snapshot, as encoding did", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { snapshotSequence, projection } = yield* projections.getThreadSnapshot(PARENT);
      const wire = projectThreadProjectionForWire(projection);
      const [first, ...rest] = wire.turnItems;
      const invalid = {
        snapshotSequence,
        projection: {
          ...wire,
          turnItems: [
            { ...first!, status: "unknown" } as unknown as OrchestrationV2TurnItem,
            ...rest,
          ],
        },
      };
      const notJson = NOT_JSON_VALUES.map((value) => ({ value })).map((answers) => ({
        snapshotSequence,
        projection: { ...wire, runtimeRequests: runtimeRequests([answers]) },
      }));
      for (const snapshot of [invalid, ...notJson]) {
        assert.throws(() => referenceBody(snapshot));
        const error = yield* encodeThreadSnapshotBody(snapshot).pipe(Effect.flip);
        assert.isTrue(Schema.isSchemaError(error));
      }
    }),
  );

  it.effect("keeps chunks bounded for large and deeply nested answers", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { snapshotSequence, projection } = yield* projections.getThreadSnapshot(FORK);
      // Deeper than a recursive writer, or one JSON.stringify call, can go: with and without bulk.
      const nest = (leaf: unknown) => {
        let deep = leaf;
        for (let depth = 0; depth < 3_000; depth++) deep = depth % 2 === 0 ? [deep] : { deep };
        return deep;
      };
      const snapshot = {
        snapshotSequence,
        projection: {
          ...projectThreadProjectionForWire(projection),
          // Each answer set is large or deep in its own way.
          runtimeRequests: runtimeRequests([
            { reply: { toJSON: null, text: `${TEXT}\n`.repeat(40_000) } },
            { [TEXT.repeat(40_000)]: 0 },
            // Under a chunk before escaping, six times that after: each NUL is written as \u0000.
            { nul: "\u0000".repeat(200_000) },
            { many: Array.from({ length: 200_000 }, (_, index) => ({ index, text: "x" })) },
            { deep: nest(TEXT.repeat(40_000)) },
            { deep: nest(TEXT) },
          ]),
        },
      };
      const streamed = yield* streamedBody(snapshot);
      assert.isTrue(streamed.bytes.equals(referenceBody(snapshot)));
      assert.isAtMost(streamed.largestChunk, 1024 * 1024);
    }),
  );

  it.effect("writes an answer too deep for JSON.stringify here, without failing mid-body", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { snapshotSequence, projection } = yield* projections.getThreadSnapshot(FORK);
      const snapshot = (deep: unknown) => ({
        snapshotSequence,
        projection: {
          ...projectThreadProjectionForWire(projection),
          runtimeRequests: runtimeRequests([{ deep }]),
        },
      });
      // A two-byte string puts JSON.stringify on its recursive path, which this depth overflows.
      let deep: unknown = "𝄞".repeat(10);
      let deepJson = JSON.stringify(deep);
      for (let depth = 0; depth < 20_000; depth++) {
        deep = depth % 2 === 0 ? [deep] : { deep };
        deepJson = depth % 2 === 0 ? `[${deepJson}]` : `{"deep":${deepJson}}`;
      }
      assert.throws(() => JSON.stringify(deep), RangeError);
      const expected = referenceBody(snapshot("placeholder"))
        .toString("utf8")
        .replace('"deep":"placeholder"', () => `"deep":${deepJson}`);
      const streamed = yield* streamedBody(snapshot(deep));
      assert.strictEqual(streamed.bytes.toString("utf8"), expected);
    }),
  );
});
