import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ComputerTaskBroker from "../../ComputerTaskBroker.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { layerInProcessMcpServer, toolkitRegistration } from "../../McpHttpServer.ts";
import { ComputerToolkitHandlersLive } from "./handlers.ts";
import { ComputerToolkit } from "./tools.ts";

const now = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-mac");
const projectId = ProjectId.make("project-t3");
const sourceThreadId = ThreadId.make("thread-source");

// A caller in the middle of a turn: computer_send acts as the calling thread,
// so the access gate refuses one whose run has ended.
const source: OrchestrationV2ThreadShell = {
  ...McpToolAccessTestkit.liveThreadShell(sourceThreadId, { runtimeMode: "approval-required" }),
  projectId,
  title: "Source Agent",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
};

const project: ProjectStore.ProjectRow = {
  projectId,
  title: "t3code",
  workspaceRoot: "/Users/me/dev/t3code",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
  pinnedAt: null,
  archivedAt: null,
  deletedAt: null,
};

const invocation = {
  environmentId,
  capabilities: new Set<never>(),
  issuedAt: 1,
  requestNamespace: `thread:${sourceThreadId}`,
  thread: {
    threadId: sourceThreadId,
    providerSessionId: "provider-session-computers",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-task-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-task-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const descriptor = {
  environmentId,
  label: "Sheehan's Mac",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: false },
};

function makeTestLayer(dispatched: Array<OrchestrationV2ServerCommand>) {
  const threads = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(threadId === sourceThreadId ? source : null),
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 11, storedEvents: [] };
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];

  const projects = {
    get: (id: ProjectId) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  } as unknown as ProjectStore.ProjectStoreV2["Service"];

  const environment = {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor),
    // Nothing in these handlers renames the environment; the stub exists so
    // the service shape is complete.
    setEnvironmentLabel: () => Effect.void,
  } satisfies ServerEnvironment.ServerEnvironment["Service"];

  return toolkitRegistration(ComputerToolkit, ComputerToolkitHandlersLive).pipe(
    Layer.provideMerge(layerInProcessMcpServer),
    Layer.provideMerge(ComputerTaskBroker.layer),
    Layer.provideMerge(Layer.succeed(ThreadManagementService.ThreadManagementService, threads)),
    Layer.provideMerge(Layer.succeed(ProjectStore.ProjectStoreV2, projects)),
    Layer.provideMerge(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

it.effect("lists this machine and starts a local thread for computer_send this", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.some(({ tool }) => tool.name === "computer_list")).toBe(true);
      expect(server.tools.some(({ tool }) => tool.name === "computer_send")).toBe(true);

      const listed = yield* server
        .callTool({ name: "computer_list", arguments: {} })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        );
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        thisEnvironmentId: environmentId,
        computers: [{ label: "Sheehan's Mac", thisMachine: true }],
      });

      const sent = yield* server
        .callTool({
          name: "computer_send",
          arguments: { computer: "this", message: "Build the Windows installer." },
        })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        );
      expect(sent.isError).toBe(false);
      expect(dispatched.map(({ type }) => type)).toEqual(["thread.create", "message.dispatch"]);
      const [create, send] = dispatched;
      if (create?.type === "thread.create" && send?.type === "message.dispatch") {
        expect(create.projectId).toBe(projectId);
        expect(create.title).toBe("Build the Windows installer.");
        expect(send.threadId).toBe(create.threadId);
        expect(send.senderThreadId).toBe(sourceThreadId);
        expect(send.text).toContain("Build the Windows installer.");
        expect(send.dispatchMode).toEqual({ type: "start_immediately" });
      }
      expect(sent.structuredContent).toMatchObject({ environmentId, projectId });
    }),
  ).pipe(Effect.provide(makeTestLayer(dispatched)));
});

it.effect("refuses an unknown computer", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const sent = yield* server
        .callTool({
          name: "computer_send",
          arguments: { computer: "toaster", message: "hello" },
        })
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        );
      expect(sent.isError).toBe(true);
      const text = sent.content.find((part) => part.type === "text");
      expect(text?.type === "text" && text.text.includes("No computer matches 'toaster'")).toBe(
        true,
      );
    }),
  ).pipe(Effect.provide(makeTestLayer(dispatched)));
});
