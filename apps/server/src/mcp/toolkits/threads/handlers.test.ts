import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadRelayToolkitHandlersLive } from "./handlers.ts";
import { ThreadRelayToolkit } from "./tools.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-relay");
const sourceThreadId = ThreadId.make("thread-source");
const targetThreadId = ThreadId.make("thread-target");

function makeThread(
  id: ThreadId,
  input: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId,
    title: id === sourceThreadId ? "Source Agent" : "Target Agent",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const source = makeThread(sourceThreadId);
const target = makeThread(targetThreadId, {
  branch: "feat/parser",
  worktreePath: "/tmp/worktree-target",
  updatedAt: "2026-01-01T00:00:01.000Z",
  backgroundLiveness: "working",
});

const snapshot = {
  snapshotSequence: 10,
  projects: [],
  threads: [source, target],
  updatedAt: target.updatedAt,
} satisfies OrchestrationShellSnapshot;

const invocation = {
  environmentId: EnvironmentId.make("environment-relay"),
  threadId: sourceThreadId,
  providerSessionId: "provider-session-relay",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set<never>(),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-relay-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

function makeTestLayer(dispatched: Array<OrchestrationCommand>) {
  const query = {
    getShellSnapshot: () => Effect.succeed(snapshot),
    getThreadShellById: (threadId: ThreadId) => {
      const thread = snapshot.threads.find(({ id }) => id === threadId);
      return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread));
    },
  } as unknown as ProjectionSnapshotQueryShape;

  const engine = {
    readEvents: () => Stream.empty,
    dispatch: (command) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: 11 });
    },
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(10),
  } satisfies OrchestrationEngineShape;

  return McpServer.toolkit(ThreadRelayToolkit).pipe(
    Layer.provide(ThreadRelayToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("lists siblings and durably dispatches attributed thread messages", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const listTool = server.tools.find(({ tool }) => tool.name === "thread_list");
      expect(listTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(listTool?.tool.annotations?.idempotentHint).toBe(true);

      const sendTool = server.tools.find(({ tool }) => tool.name === "thread_send");
      expect(sendTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(sendTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(sendTool?.tool.annotations?.idempotentHint).toBe(false);

      const peers = yield* server
        .callTool({ name: "thread_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(peers.isError).toBe(false);
      expect(peers.structuredContent).toEqual({
        threads: [
          {
            threadId: targetThreadId,
            title: "Target Agent",
            status: "working",
            branch: "feat/parser",
            workspace: "worktree",
            updatedAt: target.updatedAt,
          },
        ],
        truncated: false,
      });

      const sent = yield* server
        .callTool({
          name: "thread_send",
          arguments: { threadId: targetThreadId, message: "Please review the parser." },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({
        targetThreadId,
        status: "accepted",
        sequence: 11,
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: targetThreadId,
        message: { role: "user", text: "Please review the parser." },
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        sourceThreadMessage: { threadId: sourceThreadId },
      });
    }),
  ).pipe(Effect.provide(makeTestLayer(dispatched)));
});
