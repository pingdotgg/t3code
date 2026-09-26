// @effect-diagnostics nodeBuiltinImport:off - Measures real local HTTP/WebSocket sockets.
import * as NodeHttp from "node:http";
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
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2GetShellSnapshotError,
  ProviderDriverKind,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { Rpc, RpcGroup, RpcServer, RpcSerialization } from "effect/unstable/rpc";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../src/orchestration-v2/ThreadManagementService.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { layer as backgroundLiveness } from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { layer as planProgress } from "../src/orchestration/ThreadPlanProgress.ts";
import { ProjectEnrichmentService } from "../src/project/ProjectEnrichmentService.ts";
import { orchestrationHttpApiLayer } from "../src/orchestration-v2/http.ts";
import { httpCompressionLayer } from "../src/http.ts";
import { subscribeOrchestrationV2Thread, subscribeOrchestrationV2Shell } from "../src/ws.ts";
import {
  measureHttpGet,
  openMeasuredWsClient,
  type MeasuredWsClient,
} from "./NetworkTransferMeasurement.integration.ts";
import { makeSqlStatementCounter } from "./SqlStatementCounter.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  transferBudgetViolations,
  type TransferBudgetRun,
} from "./TransferBudgetReport.integration.ts";
import { TRANSFER_HISTORY_TURN_COUNT } from "./fixtures/transferBudget.ts";
import { THREAD_ID, threadCreated, turnEvents } from "./TransferBudgetV2Fixture.integration.ts";

const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);
const decodeShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ShellSnapshot)),
);

const persistence = EventSink.layer.pipe(
  Layer.provideMerge(EventStore.layerFromOrchestrationEventStore),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);
// The facade's import/command paths are outside this measurement. Its reads and
// stream delegate to the real SQL projection and event sink, as the runtime does.
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    return Layer.mock(ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadShell: (id) => projections.getThreadShell(id).pipe(Effect.orDie),
      getShellSnapshot: (options) => projections.getShellSnapshot(options).pipe(Effect.orDie),
      streamStoredEventsFrom: (input) =>
        sink.stream({ ...input, bounded: true }).pipe(Stream.orDie),
    });
  }),
);
const enrichment = Layer.unwrap(
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<never>();
    return Layer.mock(ProjectEnrichmentService)({
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);
const services = management.pipe(
  Layer.provideMerge(
    OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(backgroundLiveness),
      Layer.provide(planProgress),
    ),
  ),
  Layer.provideMerge(enrichment),
  Layer.provideMerge(persistence),
);
class TransferApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
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
const handlers = group.toLayer({
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
    Stream.unwrap(subscribeOrchestrationV2Thread(input)),
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
    Stream.unwrap(subscribeOrchestrationV2Shell(input)),
});
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(TransferApi).pipe(
    Layer.provide(orchestrationHttpApiLayer),
    Layer.provide(auth),
  ),
  RpcServer.layerHttp({ group, path: "/ws", protocol: "websocket" }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerJson),
  ),
).pipe(Layer.provide(httpCompressionLayer), Layer.provide(NodeHttpPlatform.layer));

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
const subscribe = Effect.fn("transfer.subscribe")(function* (
  client: MeasuredWsClient,
  kind: "thread" | "shell",
  afterSequence: number,
) {
  const queue = yield* Queue.unbounded<StreamItem>();
  const stream: Stream.Stream<StreamItem, unknown> =
    kind === "thread"
      ? client.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: THREAD_ID,
          afterSequence,
          requestCompletionMarker: true,
          acceptBoundedSnapshot: true,
        })
      : client.client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
          afterSequence,
          requestCompletionMarker: true,
        });
  yield* stream.pipe(
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

it.live(
  "reports V2 thread HTTP and WebSocket transfer budgets",
  () =>
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
            const context = yield* Effect.context<Layer.Success<typeof services>>();
            const server = yield* Layer.build(
              HttpRouter.serve(routes, { disableListenLog: true }).pipe(
                Layer.provide(Layer.succeedContext(context)),
                Layer.provideMerge(
                  NodeHttpServer.layer(NodeHttp.createServer, {
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
            assert.equal(
              decodedThread.projection.turnItems.length,
              TRANSFER_HISTORY_TURN_COUNT * 6,
            );
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
            const tq = yield* subscribe(thread, "thread", sequence);
            const sq = yield* subscribe(shell, "shell", sequence);
            const ttq = yield* subscribe(second, "thread", sequence);
            const ssq = yield* subscribe(second, "shell", sequence);
            for (const queue of [tq, sq, ttq, ssq])
              assert.equal(yield* synchronized(queue), "replay");
            const threadBefore = thread.recorder.totals();
            const shellBefore = shell.recorder.totals();
            const secondBefore = second.recorder.totals();
            const sqlBefore = counter.count();
            const events = turnEvents(provider, TRANSFER_HISTORY_TURN_COUNT, true);
            const stored = yield* sink.write({ events });
            const last = stored.at(-1)!;
            const terminal = (item: StreamItem) =>
              "sequence" in item && item.sequence >= last.sequence;
            for (const queue of [tq, sq, ttq, ssq]) yield* collectUntil(queue, terminal);
            const measuredTurnWebSocket = difference(thread.recorder.totals(), threadBefore);
            const measuredTurnShellWebSocket = difference(shell.recorder.totals(), shellBefore);
            const measuredTurnSecondClientWebSocket = difference(
              second.recorder.totals(),
              secondBefore,
            );
            const measuredTurnSqlStatements = counter.count() - sqlBefore;
            // Verify large output is retained durably even though the transport omits it.
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
            const rq = yield* subscribe(resumedThread, "thread", sequence);
            const rsq = yield* subscribe(resumedShell, "shell", sequence);
            const threadMode = yield* synchronized(rq);
            const shellMode = yield* synchronized(rsq);
            const reconnectThread = { ...resumedThread.recorder.totals(), mode: threadMode };
            const reconnectShell = { ...resumedShell.recorder.totals(), mode: shellMode };
            assert.equal(threadMode, "snapshot"); // retained MCP payload exceeds raw replay budget
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
              reconnectSqlStatements: counter.count() - reconnectSqlStart,
            } satisfies TransferBudgetRun;
          }).pipe(
            Effect.provide(Layer.fresh(services).pipe(Layer.provideMerge(NodeServices.layer))),
            Effect.withTracer(counter.tracer),
          ),
        );
        runs.push(run);
      }
      const fs = yield* FileSystem.FileSystem;
      const report = formatTransferBudgetReport(runs);
      for (const [path, contents] of [
        [process.env.T3CODE_TRANSFER_BUDGET_REPORT_PATH, report],
        [process.env.T3CODE_TRANSFER_BUDGET_RESULT_PATH, formatTransferBudgetResult(runs)],
      ])
        if (path && contents) yield* fs.writeFileString(path, contents);
      yield* Effect.log(report);
      assert.deepEqual(transferBudgetViolations(runs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
