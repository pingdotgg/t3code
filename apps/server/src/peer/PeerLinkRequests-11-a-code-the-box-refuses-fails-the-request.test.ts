import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type RuntimeMode,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import * as PeerLinks from "./PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
  type ServedPeer,
} from "./PeerLinks.testkit.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

// The laptop's agent asks the user to link the box. The laptop is its real
// orchestrator and toolkit; the box is its real descriptor and MCP OAuth on a
// socket. The user's answer goes through PeerLinkRequests, as the card's does.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const threadId = ThreadId.make("thread:laptop");
const runId = RunId.make("run:laptop");
const rootNode = NodeId.make("node:laptop:root");

/** The box needs no tools of its own: linking only signs in to its /mcp. */
const NoTools = Toolkit.make(
  Tool.make("noop", { success: Schema.Struct({}), failure: OrchestratorMcpFailure }),
);
const serveBox = servePeer(
  box,
  McpHttpServer.toolkitRegistration(
    NoTools,
    McpToolAccess.toLayer(NoTools, { noop: McpToolAccess.reads(() => Effect.succeed({})) }),
  ),
);

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-link-requests", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-link-requests", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: laptop.environmentId,
  requestNamespace: "provider-session:laptop",
  thread: {
    threadId,
    providerSessionId: "provider-session:laptop",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

/** The laptop: a real orchestrator, its orchestrator toolkit, and its links. */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  // The orchestrator's own database, apart from the one links are kept in.
  const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
  const layerDatabase = Layer.succeedContext(database);
  const layerOrchestrator = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "peer-link-requests" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(
    Layer.provide(
      Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
        offer: () => Effect.void,
        take: Effect.never,
      }),
    ),
  );
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
  );
  const layerHere = McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(PeerLinkRequests.layer),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(layerThreads),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-requests-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.fresh,
  );
  const here = yield* Layer.build(layerHere);
  const server = Context.get(here, McpServer.McpServer);
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    linksSql: Context.get(linking, SqlClient.SqlClient),
    requests: Context.get(here, PeerLinkRequests.PeerLinkRequests),
    orchestrator: Context.get(here, Orchestrator.OrchestratorV2),
    sink: Context.get(here, EventSink.EventSinkV2),
    projections: Context.get(here, ProjectionStore.ProjectionStoreV2),
    sql: Context.get(database, SqlClient.SqlClient),
    call: (args: Record<string, unknown>, callScope = scope) =>
      server
        .callTool({ name: "t3_environment_link", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, callScope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        ),
  };
});
type Laptop = Effect.Success<typeof makeLaptop>;

/** The laptop's thread, mid-turn when its agent asks, in `runtimeMode`. */
const seedThread = (
  a: Laptop,
  runtimeMode: RuntimeMode = "full-access",
  linkOrigin?: { readonly sessionId: string; readonly label: string },
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:laptop");
    yield* a.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:laptop"),
      threadId,
      projectId: ProjectId.make("project:laptop"),
      title: "Laptop",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(linkOrigin === undefined ? {} : { linkOrigin }),
    });
    yield* a.sink.write({
      commandId: CommandId.make("command:seed:laptop"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNode,
            nativeThreadRef: { driver, nativeId: "native:laptop", strength: "strong" },
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
          id: EventId.make("event:seed-node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: rootNode,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: rootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user"),
            rootNodeId: rootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const cardOf = (a: Laptop) =>
  a.orchestrator
    .getThreadProjection(threadId)
    .pipe(
      Effect.map((projection) => projection.turnItems.find((item) => item.type === "link_request")),
    );

/** The open card the agent's call left, as the user's client sees it. */
const pendingCard = (a: Laptop) =>
  Effect.gen(function* () {
    const card = yield* cardOf(a);
    expect(card).toMatchObject({ status: "waiting", linkStatus: "pending" });
    return card as Extract<NonNullable<typeof card>, { readonly type: "link_request" }>;
  });

/** The outcome notifications the thread received: what the agent reads and the user sees. */
const outcomeMessages = (a: Laptop) =>
  a.orchestrator.getThreadProjection(threadId).pipe(
    Effect.map((projection) => ({
      messages: projection.messages.filter((message) => message.notification !== undefined),
      items: projection.turnItems.filter((item) => item.type === "notification"),
    })),
  );

/** The agent's turn ends; the card outlives it. */
const endRun = (a: Laptop) =>
  Effect.gen(function* () {
    const projection = yield* a.orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.id === runId)!;
    const now = yield* DateTime.now;
    yield* a.sink.write({
      commandId: CommandId.make("command:end-run:laptop"),
      events: [
        {
          id: EventId.make("event:end-run"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
  });

/** A steer restarts the agent's turn: its run gets a new root node. */
const restartRun = (a: Laptop) =>
  Effect.gen(function* () {
    const projection = yield* a.orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.id === runId)!;
    const node = projection.nodes.find((candidate) => candidate.id === rootNode)!;
    const restarted = NodeId.make("node:laptop:root:2");
    const now = yield* DateTime.now;
    yield* a.sink.write({
      commandId: CommandId.make("command:restart-run:laptop"),
      events: [
        {
          id: EventId.make("event:restart-node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: restarted,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...node, id: restarted, rootNodeId: restarted, startedAt: now },
        },
        {
          id: EventId.make("event:restart-run"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: restarted,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, rootNodeId: restarted },
        },
      ],
    });
  });

/** What `request` records for a new card, as if it read the run before anything changed. */
const recordPendingCard = (a: Laptop, key: string) =>
  a.orchestrator.dispatch({
    type: "link_request.record",
    commandId: CommandId.make(`command:pending:${key}`),
    threadId,
    runId,
    nodeId: rootNode,
    turnItemId: TurnItemId.make(`turn-item:link-request:${key}`),
    reason: "",
    linkStatus: "pending",
  });

/**
 * Every row of every table in the laptop's database, as text, to scan for
 * anything leaked: events, projections, receipts and outbox alike.
 */
const storedText = (a: Laptop) =>
  Effect.gen(function* () {
    const tables = yield* a.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `;
    const rows = yield* Effect.forEach(tables, ({ name }) =>
      a.sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`),
    );
    const text = rows
      .flat()
      .map((row) => JSON.stringify(row))
      .join("\n");
    // The scan saw the card itself, so it read what the thread recorded.
    expect(text).toContain("link_request");
    return text;
  });

const errorOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

/** Runs `effect` a year from now, when every link made today has expired. */
const afterLinksExpire = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const ahead = Duration.days(365);
    const later = () => clock.currentTimeMillisUnsafe() + Duration.toMillis(ahead);
    const laterNanos = () => clock.currentTimeNanosUnsafe() + Duration.toNanosUnsafe(ahead);
    return yield* effect.pipe(
      Effect.provideService(Clock.Clock, {
        currentTimeMillisUnsafe: later,
        currentTimeMillis: Effect.sync(later),
        currentTimeNanosUnsafe: laterNanos,
        currentTimeNanos: Effect.sync(laterNanos),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      }),
    );
  });

const withBoth = <A, E, R>(body: (a: Laptop, b: ServedPeer) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      return yield* body(a, b);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));





















it.live("a code the box refuses fails the request with its reason, and links nothing", () =>
  withBoth((a, b) =>
    Effect.gen(function* () {
      yield* seedThread(a);
      yield* a.call({ url: b.url });
      const card = yield* pendingCard(a);
      yield* a.requests.answer({
        threadId,
        turnItemId: card.id,
        answer: {
          type: "link",
          urls: [b.url],
          access: "auto",
          pairingCode: "not-a-real-code",
        },
      });
      const failed = yield* cardOf(a);
      expect(failed).toMatchObject({ status: "failed", linkStatus: "failed" });
      const reason = failed?.type === "link_request" ? failed.failure : undefined;
      expect(reason?.length).toBeGreaterThan(0);
      const { messages } = yield* outcomeMessages(a);
      expect(messages[0]).toMatchObject({ notification: { outcome: "failed" } });
      expect(messages[0]!.text).toContain(reason);
      expect(Option.isNone(yield* a.links.get(box.environmentId))).toBe(true);
      expect(yield* storedText(a)).not.toContain("not-a-real-code");
    }),
  ),
);

