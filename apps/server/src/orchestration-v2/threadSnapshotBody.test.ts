// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { assert, it } from "@effect/vitest";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpMiddleware, HttpRouter, HttpServerResponse } from "effect/http";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { encodeThreadSnapshotBody } from "./threadSnapshotBody.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const PARENT = ThreadId.make("thread:snapshot-body:parent");
const FORK = ThreadId.make("thread:snapshot-body:fork");
const LARGE = ThreadId.make("thread:snapshot-body:large");
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

// Incompressible, so even a gzip body outgrows the socket buffers and its client can leave mid-body.
const noise = (seed: number, bytes: number) => {
  let state = seed;
  const buffer = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[index] = state & 0xff;
  }
  return buffer.toString("base64");
};

const largeItem = (ordinal: number, at: DateTime.Utc): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${LARGE}:item:${ordinal}`),
  type: "turn-item.updated",
  threadId: LARGE,
  occurredAt: at,
  payload: {
    id: TurnItemId.make(`turn-item:${LARGE}:${ordinal}`),
    threadId: LARGE,
    runId: null,
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
    type: "command_execution",
    input: noise(ordinal, 192 * 1024),
    exitCode: 0,
  },
});

const readBody = (port: number) =>
  Effect.callback<Buffer, Error>((resume) => {
    const request = NodeHttp.get(
      { host: "127.0.0.1", port, path: "/snapshot", agent: false },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
        response.on("error", (error) => resume(Effect.fail(error)));
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
  });

const seedLarge = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  yield* projections.apply(threadCreated(LARGE, at));
  for (let ordinal = 1; ordinal <= 100; ordinal++) {
    yield* projections.apply(largeItem(ordinal, at));
  }
});

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
    Layer.provideMerge(ProjectionStore.layer),
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

it.live("ends the request when its client leaves mid-body, compressed or not", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { snapshotSequence, projection } = yield* projections.getThreadSnapshot(LARGE);
    const snapshot = { snapshotSequence, projection: projectThreadProjectionForWire(projection) };
    const exits = yield* Queue.unbounded<Exit.Exit<unknown, unknown>>();
    const server = NodeHttp.createServer();
    const route = HttpRouter.add(
      "GET",
      "/snapshot",
      encodeThreadSnapshotBody(snapshot).pipe(
        Effect.map((body) => HttpServerResponse.stream(body, { contentType: "application/json" })),
      ),
    );
    const serverScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
    yield* Layer.buildWithScope(
      HttpRouter.serve(route, {
        disableListenLog: true,
        disableLogger: true,
        middleware: (app) =>
          HttpMiddleware.compression()(Effect.onExit(app, (exit) => Queue.offer(exits, exit))),
      }).pipe(
        Layer.provide(NodeHttpServer.layer(() => server, { port: 0 })),
        Layer.provide(NodeHttpPlatform.layer),
      ),
      serverScope,
    );
    const { port } = server.address() as NodeNet.AddressInfo;

    for (const encoding of ["gzip", "identity"]) {
      const firstBytes = yield* Deferred.make<string>();
      const request = NodeHttp.get(
        {
          host: "127.0.0.1",
          port,
          path: "/snapshot",
          agent: false,
          headers: { "accept-encoding": encoding },
        },
        (response) =>
          response.once("data", () => {
            Deferred.doneUnsafe(
              firstBytes,
              Effect.succeed(response.headers["content-encoding"] ?? "identity"),
            );
            request.destroy();
          }),
      );
      request.on("error", () => undefined);
      assert.strictEqual(yield* Deferred.await(firstBytes), encoding);
      assert.isTrue(Exit.hasInterrupts(yield* Queue.take(exits)));
    }
    assert.isTrue((yield* readBody(port)).equals(referenceBody(snapshot)));
    assert.isTrue(Exit.isSuccess(yield* Queue.take(exits)));
  }).pipe(Effect.provide(seededStore(seedLarge))),
);
