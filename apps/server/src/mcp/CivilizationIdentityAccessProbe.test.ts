import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as ThreadAccess from "./threadAccess.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:g1");
const environmentId = EnvironmentId.make("environment:g1");
const sameWorkspace = "C:\\synthetic\\g1-shared-workspace";
const modelSelection = { instanceId, model: "g1-probe-model" };

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("G1 never starts a provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "civilization-g1-identity" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerThreadManagement = ThreadManagement.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(layerOrchestrator),
);

const SendProbeTool = Tool.make("civilization_send_probe", {
  parameters: Schema.Struct({
    targetThreadId: ThreadId,
    // Attack-only probe parameter. The production send contract must not
    // expose a sender override at all; this proves a supplied claim cannot win.
    claimedSenderThreadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({
    senderThreadId: ThreadId,
    senderProjectId: ProjectId,
    senderRunId: RunId,
    targetThreadId: ThreadId,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
});
const SendProbeToolkit = Toolkit.make(SendProbeTool);
const sendProbeHandlers: McpToolAccess.Handlers<typeof SendProbeToolkit.tools> = {
  civilization_send_probe: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        scope,
        "Civilization send",
      );
      const caller = yield* ThreadAccess.readCaller();
      yield* ThreadAccess.assertLiveCaller(caller);
      if (
        input.claimedSenderThreadId !== undefined &&
        input.claimedSenderThreadId !== threadScope.thread.threadId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The sender is the authenticated calling thread and cannot be overridden.",
        });
      }
      if (caller.caller === undefined || caller.caller.activeRunId === null) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Civilization send requires a live calling thread run.",
        });
      }
      return {
        senderThreadId: threadScope.thread.threadId,
        senderProjectId: caller.caller.projectId,
        senderRunId: caller.caller.activeRunId,
        targetThreadId: input.targetThreadId,
      };
    }),
  ),
};
const layerSendProbe = McpHttpServer.toolkitRegistration(
  SendProbeToolkit,
  McpToolAccess.toLayer(SendProbeToolkit, sendProbeHandlers),
).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provideMerge(layerThreadManagement));
const layerProbe = Layer.mergeAll(layerOrchestrator, layerThreadManagement, layerSendProbe);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "civilization-g1", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "civilization-g1", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const ProbeOutcome = Schema.Union([
  Schema.Struct({
    senderThreadId: ThreadId,
    senderProjectId: ProjectId,
    senderRunId: RunId,
    targetThreadId: ThreadId,
  }),
  Schema.Struct({ code: Schema.String }),
]);
const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(ProbeOutcome));

const callSend = (
  scope: McpInvocationContext.McpInvocationScope,
  targetThreadId: ThreadId,
  claimedSenderThreadId?: ThreadId,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({
        name: "civilization_send_probe",
        arguments: {
          targetThreadId,
          ...(claimedSenderThreadId === undefined ? {} : { claimedSenderThreadId }),
        },
      }),
    ),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const threadScope = (
  threadId: ThreadId,
  providerSessionId: string,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: providerSessionId,
  thread: { threadId, providerSessionId, providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1_000,
});

const oauthScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:g1-outsider",
  thread: undefined,
  client: { sessionId: "g1-outsider", label: "OAuth outsider", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1_000,
});

const createThread = (threadId: ThreadId, title: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`g1:create:${threadId}`),
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "g1",
        worktreePath: sameWorkspace,
        createdBy: "user",
        creationSource: "web",
      }),
    ),
    Effect.asVoid,
  );

const writeRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status: "running" | "completed";
  readonly eventId: string;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(input.eventId),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${input.runId}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: input.status === "completed" ? now : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

const completeRun = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = yield* projections.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.id === runId);
    assert.isDefined(run);
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`g1:complete:${runId}`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...run!, status: "completed", completedAt: now },
        },
      ],
    });
  });

it.effect(
  "binds concurrent same-workspace threads and a fork to their authenticated principals",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const a = ThreadId.make("thread:g1:a");
      const b = ThreadId.make("thread:g1:b");
      const source = ThreadId.make("thread:g1:fork-source");
      const fork = ThreadId.make("thread:g1:fork");
      const runA = RunId.make("run:g1:a");
      const runB = RunId.make("run:g1:b");
      const sourceRun = RunId.make("run:g1:fork-source");
      const forkRun = RunId.make("run:g1:fork");

      yield* createThread(a, "A");
      yield* createThread(b, "B");
      yield* createThread(source, "Fork source");
      yield* writeRun({ threadId: a, runId: runA, status: "running", eventId: "g1:run:a" });
      yield* writeRun({ threadId: b, runId: runB, status: "running", eventId: "g1:run:b" });
      yield* writeRun({
        threadId: source,
        runId: sourceRun,
        status: "completed",
        eventId: "g1:run:fork-source",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("g1:fork"),
        sourceThreadId: source,
        targetThreadId: fork,
        sourcePoint: { type: "run", runId: sourceRun },
        createdBy: "user",
        creationSource: "web",
      });
      yield* writeRun({
        threadId: fork,
        runId: forkRun,
        status: "running",
        eventId: "g1:run:fork",
      });

      const [boundA, boundB, boundFork] = yield* Effect.all(
        [
          callSend(threadScope(a, "provider-session:g1:a"), b),
          callSend(threadScope(b, "provider-session:g1:b"), a),
          callSend(threadScope(fork, "provider-session:g1:fork"), a),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(boundA, {
        senderThreadId: a,
        senderProjectId: projectId,
        senderRunId: runA,
        targetThreadId: b,
      });
      assert.deepEqual(boundB, {
        senderThreadId: b,
        senderProjectId: projectId,
        senderRunId: runB,
        targetThreadId: a,
      });
      assert.deepEqual(boundFork, {
        senderThreadId: fork,
        senderProjectId: projectId,
        senderRunId: forkRun,
        targetThreadId: a,
      });
      assert.equal((yield* projections.getThreadShell(a))?.worktreePath, sameWorkspace);
      assert.equal((yield* projections.getThreadShell(b))?.worktreePath, sameWorkspace);
      assert.equal((yield* projections.getThread(fork)).lineage.parentThreadId, source);
    }).pipe(Effect.provide(layerProbe)),
);

it.effect("rejects a forged sender, an OAuth outsider, and a stale run scope", () =>
  Effect.gen(function* () {
    const a = ThreadId.make("thread:g1:guarded-a");
    const b = ThreadId.make("thread:g1:guarded-b");
    const runA = RunId.make("run:g1:guarded-a");
    yield* createThread(a, "Guarded A");
    yield* createThread(b, "Guarded B");
    yield* writeRun({ threadId: a, runId: runA, status: "running", eventId: "g1:run:guarded-a" });
    const scopeA = threadScope(a, "provider-session:g1:guarded-a");

    assert.deepEqual(yield* callSend(scopeA, b, b), { code: "invalid_request" });
    assert.deepEqual(yield* callSend(oauthScope(), b), { code: "thread_credential_required" });

    const live = yield* callSend(scopeA, b);
    assert.deepEqual(live, {
      senderThreadId: a,
      senderProjectId: projectId,
      senderRunId: runA,
      targetThreadId: b,
    });
    yield* completeRun(a, runA);
    assert.deepEqual(yield* callSend(scopeA, b), { code: "parent_not_active" });
  }).pipe(Effect.provide(layerProbe)),
);

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

it.effect(
  "keeps bearer credentials opaque, thread-bound and revocable without harming another thread",
  () =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* McpSessionRegistry.__testing
        .make({ now: () => timestamp, livenessWindowMs: 1_000 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          Effect.provide(NodeServices.layer),
        );
      const a = ThreadId.make("thread:g1:token-a");
      const b = ThreadId.make("thread:g1:token-b");
      const issuedA = yield* registry.issue({ threadId: a, providerInstanceId: instanceId });
      const issuedB = yield* registry.issue({ threadId: b, providerInstanceId: instanceId });
      const tokenA = issuedA.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const tokenB = issuedB.config.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.notEqual(tokenA, tokenB);
      assert.equal((yield* registry.resolve(tokenA))?.thread.threadId, a);
      assert.equal((yield* registry.resolve(tokenB))?.thread.threadId, b);

      // A caller can present a token; it cannot edit the scope the registry
      // returns from that opaque token, so B's token never resolves as A.
      assert.notEqual((yield* registry.resolve(tokenB))?.thread.threadId, a);
      yield* registry.revokeProviderSession(issuedA.config.providerSessionId);
      assert.isUndefined(yield* registry.resolve(tokenA));
      assert.equal((yield* registry.resolve(tokenB))?.thread.threadId, b);

      const replacementA = yield* registry.issue({ threadId: a, providerInstanceId: instanceId });
      const replacementToken = replacementA.config.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isUndefined(yield* registry.resolve(tokenA));
      assert.equal((yield* registry.resolve(replacementToken))?.thread.threadId, a);
      timestamp += 999;
      yield* registry.touch(a);
      timestamp += 2;
      assert.equal((yield* registry.resolve(replacementToken))?.thread.threadId, a);
    }),
);
