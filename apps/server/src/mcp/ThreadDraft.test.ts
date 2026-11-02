import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATOR_MCP_THREAD_DRAFT_NOTE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

// An agent on this machine offers the user a new thread on another one. The card is a real
// orchestrator item, recorded through the real toolkit as the agent's call would record it.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const threadId = ThreadId.make("thread:draft");
const rootNode = NodeId.make("node:draft:root");
const providerThreadId = ProviderThreadId.make("provider-thread:draft");

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
  clientInfo: { name: "thread-draft", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-draft", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-laptop"),
  requestNamespace: "provider-session:draft",
  thread: {
    threadId,
    providerSessionId: "provider-session:draft",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const makeMachine = Effect.gen(function* () {
  const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
  const layerDatabase = Layer.succeedContext(database);
  const layerOrchestrator = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "thread-draft" },
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
  const machine = yield* McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
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
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-draft-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.fresh,
    Layer.build,
  );
  const server = Context.get(machine, McpServer.McpServer);
  return {
    orchestrator: Context.get(machine, Orchestrator.OrchestratorV2),
    sink: Context.get(machine, EventSink.EventSinkV2),
    draft: (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_thread_draft", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        ),
  };
});
type Machine = Effect.Success<typeof makeMachine>;

const runPayload = (runId: RunId, ordinal: number, now: DateTime.Utc) => ({
  id: runId,
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId,
  userMessageId: MessageId.make(`message:${runId}`),
  rootNodeId: rootNode,
  activeAttemptId: null,
  status: "running" as const,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

/** The thread mid-turn when its agent offers the draft. */
const seedThread = (machine: Machine, runId: RunId) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* machine.orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:draft"),
      threadId,
      projectId: ProjectId.make("project:draft"),
      title: "Draft",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* machine.sink.write({
      commandId: CommandId.make("command:seed:draft"),
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
            nativeThreadRef: { driver, nativeId: "native:draft", strength: "strong" },
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
          payload: runPayload(runId, 1, now),
        },
      ],
    });
  });

/** The first turn ends and the agent's next turn starts. */
const nextRun = (machine: Machine, ended: RunId, next: RunId) =>
  Effect.gen(function* () {
    const projection = yield* machine.orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.id === ended)!;
    const now = yield* DateTime.now;
    yield* machine.sink.write({
      commandId: CommandId.make(`command:next-run:${next}`),
      events: [
        {
          id: EventId.make(`event:end:${ended}`),
          type: "run.updated",
          threadId,
          runId: ended,
          nodeId: rootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
        {
          id: EventId.make(`event:start:${next}`),
          type: "run.updated",
          threadId,
          runId: next,
          nodeId: rootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: runPayload(next, 2, now),
        },
      ],
    });
  });

const drafts = (machine: Machine) =>
  machine.orchestrator
    .getThreadProjection(threadId)
    .pipe(
      Effect.map((projection) =>
        projection.turnItems.filter((item) => item.type === "thread_draft"),
      ),
    );

const structured = (result: { readonly structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

it.live("records one fixed card with the cleaned prompt, and a retry shows the same card", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine;
    const runId = RunId.make("run:draft:1");
    yield* seedThread(machine, runId);
    const args = {
      prompt: "Run the migration in promptL️inks.ts",
      hint: "vps",
      clientRequestId: "offer",
    };
    const first = structured(yield* machine.draft(args));
    const retry = structured(yield* machine.draft(args));
    expect(first).toMatchObject({ status: "shown", note: ORCHESTRATOR_MCP_THREAD_DRAFT_NOTE });
    expect(retry.turnItemId).toBe(first.turnItemId);
    const cards = yield* drafts(machine);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: first.turnItemId,
      title: "Thread draft",
      status: "completed",
      prompt: "Run the migration in promptLinks.ts",
      hiddenCharacters: 1,
      hint: "vps",
      runId,
      nodeId: rootNode,
    });
  }),
);

it.live("a key reused in a later turn makes a new card instead of answering with the old one", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine;
    yield* seedThread(machine, RunId.make("run:draft:1"));
    const args = { prompt: "Start the docs fix", clientRequestId: "same-key" };
    const first = structured(yield* machine.draft(args));
    yield* nextRun(machine, RunId.make("run:draft:1"), RunId.make("run:draft:2"));
    const second = structured(yield* machine.draft(args));
    expect(second.turnItemId).not.toBe(first.turnItemId);
    expect((yield* drafts(machine)).map((card) => card.runId)).toEqual([
      "run:draft:1",
      "run:draft:2",
    ]);
  }),
);

it.live("refuses a prompt the user could not read in full", () =>
  Effect.gen(function* () {
    const machine = yield* makeMachine;
    yield* seedThread(machine, RunId.make("run:draft:1"));
    const hidden = yield* machine.draft({ prompt: "​​" });
    const padded = yield* machine.draft({ prompt: `Fix the README.${"\n".repeat(8)}rm -rf ~` });
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden.content)).toContain("only hidden characters");
    expect(padded.isError).toBe(true);
    expect(JSON.stringify(padded.content)).toContain("long runs of blank lines");
    expect(yield* drafts(machine)).toHaveLength(0);
  }),
);

it.live(
  "a draft recorded after Stop shows no card, and a retry of a recorded one stays as it was",
  () =>
    Effect.gen(function* () {
      const machine = yield* makeMachine;
      const runId = RunId.make("run:draft:1");
      yield* seedThread(machine, runId);
      const record = (key: string, turnItemId: TurnItemId) =>
        machine.orchestrator.dispatch({
          type: "thread_draft.record",
          commandId: CommandId.make(`command:draft:${key}`),
          threadId,
          runId,
          nodeId: rootNode,
          turnItemId,
          prompt: "Start the docs fix",
          hiddenCharacters: 0,
        });
      const recorded = TurnItemId.make("turn-item:thread-draft:recorded");
      yield* record("first", recorded);
      yield* machine.orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:stop:draft"),
        threadId,
      });
      // Another command for the recorded card reaches the handler, not the receipt.
      yield* record("again", recorded);
      const late = yield* record("late", TurnItemId.make("turn-item:thread-draft:late")).pipe(
        Effect.flip,
      );
      expect(String(late.cause)).toContain("not active");
      expect((yield* drafts(machine)).map((card) => card.id)).toEqual([recorded]);
    }),
);
