import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { shortId } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as UserView from "./UserView.ts";
import * as UserViewTools from "./UserViewTools.ts";

const ENVIRONMENT = EnvironmentId.make("environment:user-view-tools");
const REPLIES = ThreadId.make("thread:user-view-tools:replies");
const NORMAL = ThreadId.make("thread:user-view-tools:normal");
const at = DateTime.makeUnsafe("2026-11-15T16:48:00.000Z");
const provider = ProviderInstanceId.make("codex");

const threadCreated = (id: ThreadId): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}:created`),
  type: "thread.created",
  threadId: id,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:user-view-tools"),
    title: String(id),
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const base = (threadId: ThreadId, n: number) => ({
  id: TurnItemId.make(`item:${threadId}:${n}`),
  threadId,
  runId: null,
  nodeId: NodeId.make(`node:${threadId}`),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: n,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

/** `count` exchanges: a typed message, then the agent's answer to it. */
const exchanges = (threadId: ThreadId, count: number): ReadonlyArray<OrchestrationV2TurnItem> =>
  Array.from({ length: count }, (_, index): ReadonlyArray<OrchestrationV2TurnItem> => {
    const messageId = MessageId.make(`message:${threadId}:${index}`);
    return [
      {
        ...base(threadId, 2 * index),
        createdBy: "user",
        creationSource: "web",
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: `Question ${index}`,
        attachments: [],
      },
      {
        ...base(threadId, 2 * index + 1),
        type: "dynamic_tool",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: `Answer ${index}`, reply_to: shortId(messageId) },
      },
    ];
  }).flat();

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  for (const [threadId, count] of [
    [REPLIES, 200],
    [NORMAL, 1],
  ] as const) {
    yield* projections.apply(threadCreated(threadId));
    for (const item of exchanges(threadId, count))
      yield* projections.apply({
        id: EventId.make(`event:${item.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      });
  }
});

const layer = McpHttpServer.toolkitRegistration(
  UserViewTools.UserViewToolkit,
  UserViewTools.layerHandlers,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(UserView.layer),
  Layer.provide(Layer.effectDiscard(seed)),
  Layer.provide(ServerSettings.layerTest({ threadDisplayModes: { [REPLIES]: "chat-replies" } })),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-user-view-tools-" })),
  Layer.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "user-view-tools", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "user-view-tools", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: ENVIRONMENT,
  requestNamespace: "user-view-tools-session",
  thread: {
    threadId: REPLIES,
    providerSessionId: "user-view-tools-session",
    providerInstanceId: provider,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const call = (args: Record<string, unknown>, caller = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_thread_user_view", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const textOf = (result: McpSchema.CallToolResult) => {
  const content: unknown = result.structuredContent;
  assert.isFalse(result.isError ?? false, JSON.stringify(result.content));
  return typeof content === "object" && content !== null && "text" in content
    ? String(content.text)
    : "";
};

it.layer(layer)("t3_thread_user_view", (it) => {
  it.effect("reads the caller's own thread and pins the view to this environment", () =>
    Effect.gen(function* () {
      const text = textOf(yield* call({ main: 2 }));
      assert.include(text, `<t3-user-view thread="${REPLIES}" mode="Chat mode"`);
      assert.include(text, "\n  Question 199\n");
      assert.include(
        text,
        `\nPinned: t3_thread_user_view {"environmentId":"${ENVIRONMENT}","threadId":"${REPLIES}","main":2,"through":"item:${REPLIES}:399","expect":"`,
      );
    }),
  );

  it.effect("reads back past its first read for an older message", () =>
    Effect.gen(function* () {
      const through = `message:${REPLIES}:3`;
      const text = textOf(yield* call({ threadId: REPLIES, through, main: 2 }));
      assert.include(text, "\n  Answer 2\n");
      assert.include(text, "\n  Question 3\n");
      assert.include(text, `"through":"${through}"`);
    }),
  );

  it.effect(
    "refuses a Normal thread, a credential without orchestration, and a thread that is gone",
    () =>
      Effect.gen(function* () {
        const normal = yield* call({ threadId: NORMAL });
        assert.isTrue(normal.isError);
        assert.include(
          JSON.stringify(normal.content),
          "Refused: this thread is in Normal, so the user sees the whole timeline; read it with t3_thread_read",
        );
        const denied = yield* call({ threadId: REPLIES }, { ...scope, capabilities: new Set() });
        assert.include(
          JSON.stringify(denied.content),
          "This MCP credential does not grant orchestration capabilities.",
        );
        const gone = yield* call({ threadId: "thread:user-view-tools:missing" });
        assert.include(
          JSON.stringify(gone.content),
          "Refused: thread thread:user-view-tools:missing is no longer available",
        );
      }),
  );
});
