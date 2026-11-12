// @effect-diagnostics nodeBuiltinImport:off - Measures real local HTTP/WebSocket sockets.
import * as NodeHttp from "node:http";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  AuthSessionId,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ShellResumable,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetShellSnapshotError,
  ProviderDriverKind,
  type EnvironmentOrchestrationShellSnapshotQuery,
  type EnvironmentOrchestrationThreadBoundedSnapshotQuery,
  type EnvironmentOrchestrationThreadHistoryQuery,
  type OrchestrationV2SubscribeShellInput,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpRouter, HttpServer } from "effect/http";
import { Rpc, RpcGroup, RpcServer, RpcSerialization } from "effect/rpc";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../src/persistence/OrchestrationEventStore.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../src/orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../src/project/ProjectService.ts";
import * as ProjectEnrichmentService from "../src/project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "../src/orchestration-v2/http.ts";
import * as ServerHttp from "../src/http.ts";
import { subscribeOrchestrationV2Thread, subscribeOrchestrationV2Shell } from "../src/ws.ts";
import {
  measureHttpGet,
  openMeasuredWsClient,
  type HttpTransferMeasurement,
  type MeasuredWsClient,
} from "./NetworkTransferMeasurement.integration.ts";
import { makeSqlStatementCounter } from "./SqlStatementCounter.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  formatTransferBudgetScenarios,
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";
import { TRANSFER_HISTORY_TURN_COUNT } from "./fixtures/transferBudget.ts";
import {
  FLEET_PROJECT_IDENTITY,
  fleetProjectCreated,
  LONG_TURN_THREAD_ID,
  longTurnThreadBatches,
  SHELL_IDLE_SUBAGENTS,
  SHELL_SETTLED_THREADS,
  shellFleetEvents,
  STALE_TODO_LAST_FINISHED_CHECKPOINT_ID,
  STALE_TODO_LIVE_RUN_ID,
  STALE_TODO_SUBAGENTS_PER_RUN,
  STALE_TODO_THREAD_ID,
  staleTodoListThreadBatches,
  THREAD_ID,
  threadCreated,
  turnEvents,
} from "./TransferBudgetV2Fixture.integration.ts";

// The opt-ins current web and mobile clients send, as client-runtime's boundedThreadSnapshotHttp.ts,
// threadHistoryHttp.ts, shellSnapshotHttp.ts, threads.ts and shell.ts send them. Each is `Required`,
// so an opt-in added to a contract fails typecheck here until this test sends it. An omitted field
// differs per request (a cursor, or what the client holds), so each scenario sends its own.
const CLIENT_BOUNDED_OPT_INS = {
  compactTurnItems: "1",
  dedupeBodies: "1",
  compactIds: "1",
  deferWork: "1",
} satisfies Required<typeof EnvironmentOrchestrationThreadBoundedSnapshotQuery.Type>;
const CLIENT_HISTORY_OPT_INS = { compactIds: "1", deferWork: "1" } satisfies Required<
  Omit<typeof EnvironmentOrchestrationThreadHistoryQuery.Type, "cursor" | "throughEntryId" | "view">
>;
const CLIENT_SHELL_OPT_INS = {
  omitIdleSubagents: "1",
  omitIdleSubagentParents: "1",
  omitOlderSettled: "1",
} satisfies Required<Omit<typeof EnvironmentOrchestrationShellSnapshotQuery.Type, "resumeFrom">>;
const CLIENT_THREAD_SUBSCRIPTION = {
  requestCompletionMarker: true,
  acceptBoundedSnapshot: true,
  acceptDeferredWork: true,
  acceptCompactTurnItems: true,
  acceptCompactIds: true,
  acceptDedupedBodies: true,
} satisfies Required<Omit<OrchestrationV2SubscribeThreadInput, "threadId" | "afterSequence">>;
type ShellResumeField = "afterSequence" | "httpSnapshotFallback" | "knownProjectIdentities";
const CLIENT_SHELL_SUBSCRIPTION = {
  requestCompletionMarker: true,
  omitIdleSubagents: true,
  omitIdleSubagentParents: true,
  omitOlderSettled: true,
} satisfies Required<Omit<OrchestrationV2SubscribeShellInput, ShellResumeField>>;
const query = (optIns: Readonly<Record<string, string>>) => new URLSearchParams(optIns).toString();
const CLIENT_BOUNDED_QUERY = query(CLIENT_BOUNDED_OPT_INS);
const CLIENT_HISTORY_QUERY = query(CLIENT_HISTORY_OPT_INS);
const CLIENT_SHELL_QUERY = query(CLIENT_SHELL_OPT_INS);
// A client that holds shell rows names their cursor in the same request.
const clientShellResumeQuery = (resumeFrom: number) =>
  query({
    ...CLIENT_SHELL_OPT_INS,
    resumeFrom: String(resumeFrom),
  } satisfies Required<typeof EnvironmentOrchestrationShellSnapshotQuery.Type>);

const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);
const decodeBoundedSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeHistoryPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
const decodeShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellHttpSnapshot)),
);
const decodeShellResumable = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellResumable)),
);

const layerPersistence = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerManagement = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadHistoryPage: (id, cursor, throughEntryId, conversationOnly) =>
        projections
          .getThreadHistoryPage(id, cursor, throughEntryId, conversationOnly)
          .pipe(Effect.orDie),
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
      getShellSnapshot: (options) => projections.getShellSnapshot(options).pipe(Effect.orDie),
      listActiveShellIndex: () => projections.listActiveShellIndex().pipe(Effect.orDie),
      listActiveSubagentThreadIds: () =>
        projections.listActiveSubagentThreadIds().pipe(Effect.orDie),
      readShellSnapshot: (options) =>
        projections.readShellSnapshot(options).pipe(Effect.map(Effect.orDie), Effect.orDie),
      streamStoredEventsFrom: (input) =>
        sink.stream({ ...input, bounded: true }).pipe(Stream.orDie),
    });
  }),
);
const layerEnrichment = Layer.unwrap(
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<never>();
    return Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: FLEET_PROJECT_IDENTITY,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);
const layerServices = layerManagement.pipe(
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("transfer-test")),
    }),
  ),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provideMerge(layerEnrichment),
  Layer.provideMerge(layerPersistence),
);
class TransferApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const layerAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("transfer-session"),
      subject: "transfer-test",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);
const group = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
    payload: OrchestrationV2RpcSchemas.subscribeThread.input,
    success: OrchestrationV2RpcSchemas.subscribeThread.output,
    error: OrchestrationV2GetThreadProjectionError,
    stream: true,
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: OrchestrationV2RpcSchemas.subscribeShell.input,
    success: OrchestrationV2RpcSchemas.subscribeShell.output,
    error: OrchestrationV2GetShellSnapshotError,
    stream: true,
  }),
);
const layerHandlers = group.toLayer({
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
    Stream.unwrap(subscribeOrchestrationV2Thread(input)),
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
    Stream.unwrap(subscribeOrchestrationV2Shell(input)),
});
const layerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(TransferApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(layerAuth),
  ),
  RpcServer.layerHttp({ group, path: "/ws", protocol: "websocket" }).pipe(
    Layer.provide(layerHandlers),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(ServerHttp.layerHttpCompression), Layer.provide(NodeHttpPlatform.layer));

function difference(
  after: { wireBytes: number; decodedBytes: number; messages: number },
  before: typeof after,
) {
  return {
    wireBytes: after.wireBytes - before.wireBytes,
    decodedBytes: after.decodedBytes - before.decodedBytes,
    messages: after.messages - before.messages,
  };
}
type StreamItem = OrchestrationV2ThreadStreamItem | OrchestrationV2ShellStreamItem;
const collectUntil = Effect.fn("transfer.collectUntil")(function* <T extends StreamItem>(
  queue: Queue.Queue<T>,
  done: (item: T) => boolean,
) {
  const items: T[] = [];
  while (true) {
    const item = yield* Queue.take(queue);
    items.push(item);
    if (done(item)) return items;
  }
});
type Subscription =
  | ({ readonly thread: ThreadId } & Pick<OrchestrationV2SubscribeThreadInput, "afterSequence">)
  | ({ readonly shell: true } & Pick<OrchestrationV2SubscribeShellInput, ShellResumeField>);
function subscriptionStream(
  client: MeasuredWsClient,
  subscription: Subscription,
): Stream.Stream<StreamItem, unknown> {
  if ("thread" in subscription) {
    const { thread, ...resume } = subscription;
    return client.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      ...CLIENT_THREAD_SUBSCRIPTION,
      ...resume,
      threadId: thread,
    });
  }
  const { shell: _, ...resume } = subscription;
  return client.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
    ...CLIENT_SHELL_SUBSCRIPTION,
    ...resume,
  });
}
const subscribe = Effect.fn("transfer.subscribe")(function* (
  client: MeasuredWsClient,
  subscription: Subscription,
) {
  const queue = yield* Queue.unbounded<StreamItem>();
  yield* subscriptionStream(client, subscription).pipe(
    Stream.runForEach((item) => Queue.offer(queue, item)),
    Scope.provide(client.scope),
    Effect.forkIn(client.scope),
  );
  return queue;
});
const synchronized = (queue: Queue.Queue<StreamItem>) =>
  collectUntil(queue, (item) => item.kind === "synchronized").pipe(
    Effect.map((items) =>
      items.some((item) => item.kind === "snapshot") ? ("snapshot" as const) : ("replay" as const),
    ),
  );

it.live("reports V2 thread HTTP and WebSocket transfer budgets", () =>
  Effect.gen(function* () {
    const runs: TransferBudgetRun[] = [];
    for (const provider of [
      ProviderDriverKind.make("codex"),
      ProviderDriverKind.make("claudeAgent"),
    ]) {
      const counter = makeSqlStatementCounter();
      const run = yield* Effect.scoped(
        Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const projection = yield* ProjectionStore.ProjectionStoreV2;
          yield* sink.write({ events: [threadCreated(provider)] });
          for (let index = 0; index < TRANSFER_HISTORY_TURN_COUNT; index++)
            yield* sink.write({ events: turnEvents(provider, index, false) });
          const context = yield* Effect.context<Layer.Success<typeof layerServices>>();
          const server = yield* Layer.build(
            HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
              Layer.provide(Layer.succeedContext(context)),
              Layer.provideMerge(
                NodeHttpServer.layer(NodeHttp.createServer, {
                  host: "127.0.0.1",
                  port: 0,
                  websocket: { perMessageDeflate: true },
                }),
              ),
            ),
          );
          const address = Context.get(server, HttpServer.HttpServer).address;
          if (!("port" in address)) return yield* Effect.die("Expected TCP server");
          const base = `http://127.0.0.1:${address.port}`;
          const threadSnapshot = yield* measureHttpGet({
            url: `${base}/api/orchestration/threads/${THREAD_ID}`,
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
          });
          assert.equal(
            threadSnapshot.status,
            200,
            Buffer.from(threadSnapshot.decodedBody).toString(),
          );
          assert.equal(threadSnapshot.contentEncoding, "gzip");
          const decodedThread = yield* decodeThreadSnapshot(
            Buffer.from(threadSnapshot.decodedBody).toString(),
          );
          assert.equal(decodedThread.projection.messages.length, TRANSFER_HISTORY_TURN_COUNT * 2);
          assert.equal(decodedThread.projection.turnItems.length, TRANSFER_HISTORY_TURN_COUNT * 6);
          assert.notInclude(Buffer.from(threadSnapshot.decodedBody).toString(), "digest=");
          const shellSnapshot = yield* measureHttpGet({
            url: `${base}/api/orchestration/shell`,
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
          });
          assert.equal(shellSnapshot.status, 200);
          const decodedShell = yield* decodeShellSnapshot(
            Buffer.from(shellSnapshot.decodedBody).toString(),
          );
          assert.equal(decodedShell.threads.length, 1);
          const sequence = decodedThread.snapshotSequence;
          assert.equal(decodedShell.snapshotSequence, sequence);
          const url = `${base.replace("http:", "ws:")}/ws`;
          const thread = yield* openMeasuredWsClient({ url, cookie: "" });
          const shell = yield* openMeasuredWsClient({ url, cookie: "" });
          const second = yield* openMeasuredWsClient({ url, cookie: "" });
          assert.include(thread.recorder.negotiatedExtensions(), "permessage-deflate");
          const fromSnapshot = { afterSequence: sequence };
          const tq = yield* subscribe(thread, { thread: THREAD_ID, ...fromSnapshot });
          const sq = yield* subscribe(shell, { shell: true, ...fromSnapshot });
          const ttq = yield* subscribe(second, { thread: THREAD_ID, ...fromSnapshot });
          const ssq = yield* subscribe(second, { shell: true, ...fromSnapshot });
          for (const queue of [tq, sq, ttq, ssq])
            assert.equal(yield* synchronized(queue), "replay");
          const threadBefore = thread.recorder.totals();
          const shellBefore = shell.recorder.totals();
          const secondBefore = second.recorder.totals();
          const sqlBefore = counter.count();
          const events = turnEvents(provider, TRANSFER_HISTORY_TURN_COUNT, true);
          const stored = yield* sink.write({ events });
          const last = stored.at(-1)!;
          const threadTerminal = (item: StreamItem) =>
            "sequence" in item && item.sequence >= last.sequence;
          // Shell items carry the shell read when their batch is projected, and unchanged
          // shells are skipped, so a turn split across batches may never yield an item at
          // the last sequence. Wait for the final shell instead.
          const finalShell = yield* projection.getThreadShell(THREAD_ID);
          const shellTerminal = (item: StreamItem) =>
            item.kind === "thread.updated" && NodeUtil.isDeepStrictEqual(item.thread, finalShell);
          const liveTurn = yield* collectUntil(tq, threadTerminal);
          yield* collectUntil(ttq, threadTerminal);
          // A direct check, so live dedupe stays guarded however small the turn gets.
          const liveAnswer = liveTurn.flatMap((item) =>
            item.kind === "event" &&
            item.event.type === "turn-item.updated" &&
            item.event.payload.type === "assistant_message"
              ? [item.event.payload]
              : [],
          );
          assert.equal(liveAnswer.length, 1);
          assert.equal(liveAnswer[0]!.textOmitted, true);
          for (const queue of [sq, ssq]) yield* collectUntil(queue, shellTerminal);
          const measuredTurnWebSocket = difference(thread.recorder.totals(), threadBefore);
          const measuredTurnShellWebSocket = difference(shell.recorder.totals(), shellBefore);
          const measuredTurnSecondClientWebSocket = difference(
            second.recorder.totals(),
            secondBefore,
          );
          const measuredTurnSqlStatements = counter.count() - sqlBefore;
          const durable = yield* projection.getThreadProjection(THREAD_ID);
          assert.isTrue(
            durable.turnItems.some(
              (item) =>
                item.type === "dynamic_tool" && JSON.stringify(item.output).length > 1_000_000,
            ),
          );
          yield* second.close;
          const reconnectSqlStart = counter.count();
          const resumedThread = yield* openMeasuredWsClient({ url, cookie: "" });
          const resumedShell = yield* openMeasuredWsClient({ url, cookie: "" });
          const rq = yield* subscribe(resumedThread, { thread: THREAD_ID, ...fromSnapshot });
          const rsq = yield* subscribe(resumedShell, { shell: true, ...fromSnapshot });
          const threadMode = yield* synchronized(rq);
          const shellMode = yield* synchronized(rsq);
          const reconnectThread = { ...resumedThread.recorder.totals(), mode: threadMode };
          const reconnectShell = { ...resumedShell.recorder.totals(), mode: shellMode };
          const reconnectSqlStatements = counter.count() - reconnectSqlStart;
          assert.equal(threadMode, "snapshot");

          const get = (path: string) =>
            measureHttpGet({
              url: `${base}${path}`,
              headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
            }).pipe(Effect.tap((http) => Effect.sync(() => assert.equal(http.status, 200))));
          const decoded = (http: HttpTransferMeasurement) =>
            Buffer.from(http.decodedBody).toString();
          const longTurnPath = `/api/orchestration/threads/${LONG_TURN_THREAD_ID}`;
          const readColdOpen = (query: string) =>
            Effect.gen(function* () {
              const http = yield* get(`${longTurnPath}/bounded?${query}`);
              const snapshot = yield* decodeBoundedSnapshot(decoded(http));
              const rows = snapshot.projection.visibleTurnItems;
              const workAnchor = rows.find((row) => row.item.deferredWork !== undefined);
              return { http, rows: rows.length, cursor: snapshot.historyCursor, workAnchor };
            });
          const readHistoryPage = (cursor: string, query: string) =>
            Effect.gen(function* () {
              const http = yield* get(
                `${longTurnPath}/history?cursor=${encodeURIComponent(cursor)}&${query}`,
              );
              const page = yield* decodeHistoryPage(decoded(http));
              assert.isTrue(page.hasMoreHistory);
              return { http, rows: page.items.length };
            });
          const readShell = (query: string) =>
            Effect.gen(function* () {
              const http = yield* get(`/api/orchestration/shell?${query}`);
              const { threads, snapshotSequence, projectIdentities } = yield* decodeShellSnapshot(
                decoded(http),
              );
              return { http, rows: threads.length, snapshotSequence, projectIdentities };
            });
          // A new socket, read until the subscription caught up or the server ended it.
          const open = (subscription: Subscription) =>
            Effect.gen(function* () {
              const socket = yield* openMeasuredWsClient({ url, cookie: "" });
              const items = yield* subscriptionStream(socket, subscription).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
                Scope.provide(socket.scope),
                Effect.orDie,
              );
              const totals = socket.recorder.totals();
              yield* socket.close;
              return { kinds: items.map((item) => item.kind), items, totals };
            });

          // A phone that comes back after one ordinary turn replays it, without tool bodies.
          const shortTurn = yield* sink.write({
            events: turnEvents(provider, TRANSFER_HISTORY_TURN_COUNT + 1, false),
          });
          const shortTurnResume = yield* open({ thread: THREAD_ID, afterSequence: last.sequence });
          assert.notInclude(shortTurnResume.kinds, "snapshot");
          // The byte cap below also passes when the resume skips the turn.
          assert.isTrue(
            shortTurnResume.items.some(
              (item) => "sequence" in item && item.sequence === shortTurn.at(-1)!.sequence,
            ),
          );

          // A turn that is still running cannot defer its work, so it loads in row-budget windows.
          const [finishLongTurn, ...longTurnHistory] = longTurnThreadBatches(provider).toReversed();
          for (const events of longTurnHistory.toReversed()) yield* sink.write({ events });
          const longTurnRunningColdOpenLegacy = yield* readColdOpen("compactTurnItems=1");
          const longTurnRunningColdOpen = yield* readColdOpen(CLIENT_BOUNDED_QUERY);
          const { cursor } = longTurnRunningColdOpen;
          if (cursor === null) return yield* Effect.die("Expected older long-turn history");
          const longTurnRunningHistoryPageLegacy = yield* readHistoryPage(cursor, "");
          const longTurnRunningHistoryPage = yield* readHistoryPage(cursor, CLIENT_HISTORY_QUERY);

          // Once it finishes, its work stays on the server until a group is expanded.
          yield* sink.write({ events: finishLongTurn! });
          const longTurnColdOpen = yield* readColdOpen(CLIENT_BOUNDED_QUERY);
          const { workAnchor } = longTurnColdOpen;
          if (workAnchor?.item.deferredWork === undefined)
            return yield* Effect.die("Expected the finished long turn to defer its work");
          const longTurnWorkPage = yield* readHistoryPage(
            workAnchor.item.deferredWork.cursor,
            `view=work&throughEntryId=${encodeURIComponent(workAnchor.sourceItemId)}&compactIds=1`,
          );
          // Mobile opens a thread over the socket alone.
          const socketOpen = yield* open({ thread: LONG_TURN_THREAD_ID });
          const socketSnapshot = socketOpen.items.find(
            (item) => item.kind === "snapshot" && "projection" in item,
          );
          if (socketSnapshot?.kind !== "snapshot" || !("projection" in socketSnapshot))
            return yield* Effect.die("Expected a bounded socket snapshot");
          const longTurnSocketColdOpen = {
            ...socketOpen,
            rows: socketSnapshot.projection.visibleTurnItems.length,
          };
          // The row cap below also passes when the socket ignores the deferral and sends a window.
          assert.equal(longTurnSocketColdOpen.rows, longTurnColdOpen.rows);
          const idleThreadResume = yield* open({
            thread: LONG_TURN_THREAD_ID,
            afterSequence: socketSnapshot.snapshotSequence,
          });
          assert.deepEqual(idleThreadResume.kinds, ["synchronized"]);

          // The transfer thread plus the long-turn thread.
          const earlierThreads = decodedShell.threads.length + 1;
          // The fleet's project is in a repository. Earlier phases have no project, as on `main`.
          yield* (yield* ProjectStore.ProjectStoreV2).apply(fleetProjectCreated);
          yield* sink.write({ events: shellFleetEvents(provider) });
          const fleetShellLegacy = yield* readShell("");
          const fleetShell = yield* readShell(CLIENT_SHELL_QUERY);
          assert.equal(
            fleetShellLegacy.rows,
            earlierThreads + SHELL_SETTLED_THREADS + SHELL_IDLE_SUBAGENTS,
          );
          const { projectIdentities } = fleetShell;
          if (projectIdentities === undefined)
            return yield* Effect.die("Expected the shell snapshot to name its project identities");
          // A cold connect subscribes from the snapshot it just loaded and names its identities.
          // Without them the resume sends the project again, in a marked snapshot.
          const fleetShellSubscribe = yield* open({
            shell: true,
            afterSequence: fleetShell.snapshotSequence,
            knownProjectIdentities: projectIdentities,
          });
          assert.notInclude(fleetShellSubscribe.kinds, "snapshot");
          // A client that holds those rows asks the route whether they still resume, and keeps them.
          const fleetShellResumeHttp = yield* get(
            `/api/orchestration/shell?${clientShellResumeQuery(fleetShell.snapshotSequence)}`,
          );
          yield* decodeShellResumable(decoded(fleetShellResumeHttp));
          const fleetShellResume = { http: fleetShellResumeHttp, rows: 0 };
          // A cursor too old to replay gets the snapshot in the same answer.
          const staleShellReload = yield* readShell(clientShellResumeQuery(sequence));
          assert.equal(staleShellReload.rows, fleetShell.rows);
          // When that request fails, the socket tells the client to reload, with no snapshot.
          const staleShellResume = yield* open({
            shell: true,
            afterSequence: sequence,
            httpSnapshotFallback: true,
          });
          assert.deepEqual(staleShellResume.kinds, ["snapshot-required"]);

          for (const events of staleTodoListThreadBatches(provider)) yield* sink.write({ events });
          const staleTodoHttp = yield* get(
            `/api/orchestration/threads/${STALE_TODO_THREAD_ID}/bounded?${CLIENT_BOUNDED_QUERY}`,
          );
          const staleTodo = (yield* decodeBoundedSnapshot(decoded(staleTodoHttp))).projection;
          // Clients show the diff of the last finished turn from this record.
          assert.include(
            staleTodo.checkpoints.map((checkpoint) => checkpoint.id),
            STALE_TODO_LAST_FINISHED_CHECKPOINT_ID,
          );
          // The caps below also pass when the running turn loses its own tasks.
          assert.lengthOf(
            staleTodo.subagents.filter((subagent) => subagent.runId === STALE_TODO_LIVE_RUN_ID),
            STALE_TODO_SUBAGENTS_PER_RUN,
          );
          // The byte cap below also passes when the window loses the handoff.
          assert.lengthOf(staleTodo.contextHandoffs, 1);
          const staleTodoColdOpen = {
            http: staleTodoHttp,
            rows: staleTodo.visibleTurnItems.length,
            records: {
              nodes: staleTodo.nodes.length,
              subagents: staleTodo.subagents.length,
              plans: staleTodo.plans.length,
              providerTurns: staleTodo.providerTurns.length,
              checkpoints: staleTodo.checkpoints.length,
            },
          };
          return {
            provider,
            threadSnapshot,
            shellSnapshot,
            measuredTurnWebSocket,
            measuredTurnShellWebSocket,
            measuredTurnSecondClientWebSocket,
            measuredTurnSqlStatements,
            reconnectThread,
            reconnectShell,
            reconnectSqlStatements,
            shortTurnResume,
            longTurnRunningColdOpenLegacy,
            longTurnRunningColdOpen,
            longTurnRunningHistoryPageLegacy,
            longTurnRunningHistoryPage,
            longTurnColdOpen,
            longTurnWorkPage,
            longTurnSocketColdOpen,
            idleThreadResume,
            fleetShellLegacy,
            fleetShell,
            fleetShellSubscribe,
            fleetShellResume,
            staleShellReload,
            staleShellResume,
            staleTodoColdOpen,
          } satisfies TransferBudgetRun;
        }).pipe(
          Effect.provide(Layer.fresh(layerServices).pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.withTracer(counter.tracer),
        ),
      );
      runs.push(run);
    }
    const fs = yield* FileSystem.FileSystem;
    const report = formatTransferBudgetReport(runs);
    const outputPaths = yield* Config.all({
      report: Config.String("T3CODE_TRANSFER_BUDGET_REPORT_PATH").pipe(Config.withDefault("")),
      result: Config.String("T3CODE_TRANSFER_BUDGET_RESULT_PATH").pipe(Config.withDefault("")),
      scenarios: Config.String("T3CODE_TRANSFER_BUDGET_SCENARIOS_PATH").pipe(
        Config.withDefault(""),
      ),
    });
    for (const [path, contents] of [
      [outputPaths.report, report],
      [outputPaths.result, formatTransferBudgetResult(runs)],
      [outputPaths.scenarios, formatTransferBudgetScenarios(runs)],
    ])
      if (path && contents) yield* fs.writeFileString(path, contents);
    yield* Effect.log(report);
    assert.deepEqual(transferBudgetViolations(runs), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
