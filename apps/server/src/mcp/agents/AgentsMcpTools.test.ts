import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import { SERVER_SUPERSEDED_TOOLS } from "@t3tools/mcp-gateway/catalog";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpGatewayBrokerModule from "../McpGatewayBroker.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import { layerAgentsToolkit } from "../McpHttpServer.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

const localId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-agents-mcp-test");

const readOnlyClient = {
  sessionId: "session-read-only",
  label: "Read-only client",
  access: "read-only" as const,
};

const makeInvocation = (
  capabilities: ReadonlyArray<"orchestration" | "preview">,
  outsideClient?: typeof readOnlyClient,
) => ({
  environmentId: localId,
  thread:
    outsideClient === undefined
      ? {
          threadId,
          providerSessionId: "provider-session-agents-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client: outsideClient,
  requestNamespace: `thread:${threadId}`,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const remoteId = "environment-remote";

const makeLayer = (
  listedFor: Array<string>,
  relayed?: Array<{ method: string; args: unknown }>,
  scheduledOn: Array<string> = [],
) => {
  const port = {
    scheduledTask: async (environmentId: string) => {
      scheduledOn.push(environmentId);
      return { id: "scheduled-task:local" };
    },
    listEnvironments: async () => [
      {
        environmentId: localId,
        label: "Local",
        targetKind: "primary",
        connectionState: "connected",
      },
    ],
    listProjects: async (environmentId: string) => {
      listedFor.push(environmentId);
      return {
        items: [{ id: "project-1", title: "kaizen", repository: undefined }],
        snapshotAt: "snapshot-1",
      };
    },
  } as unknown as GatewayRuntimePort;
  const base = layerAgentsToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(
      Layer.succeed(LocalGatewayPort, {
        environmentId: localId,
        label: "Local",
        port,
        events: { subscribe: () => () => undefined },
      }),
    ),
  );
  if (relayed === undefined) return base;
  // A connected app granted read access to one other environment.
  const answers: Record<string, unknown> = {
    listEnvironments: [
      {
        environmentId: localId,
        label: "Local",
        targetKind: "bearer",
        connectionState: "connected",
      },
      {
        environmentId: remoteId,
        label: "Remote",
        targetKind: "bearer",
        connectionState: "connected",
      },
    ],
    listProjects: { items: [{ id: "project-2", title: "remote-app" }], snapshotAt: "snapshot-2" },
  };
  const broker = Layer.effect(
    McpGatewayBroker,
    Effect.gen(function* () {
      const broker = yield* McpGatewayBrokerModule.make;
      yield* broker.connect("desktop", { [remoteId]: ["read", "create"] }).pipe(
        Stream.runForEach((event) => {
          relayed.push({ method: event.method, args: event.args });
          return broker.respond("desktop", {
            connectionId: event.connectionId,
            invocationId: event.invocationId,
            result: answers[event.method],
          });
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      return broker;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  return base.pipe(Layer.provide(broker));
};

const callTool = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<"orchestration" | "preview"> = ["orchestration"],
  outsideClient?: typeof readOnlyClient,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          makeInvocation(capabilities, outsideClient),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("adds every tool that needs no event store and is not a lifecycle alias", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = new Map(server.tools.map(({ tool }) => [tool.name, tool]));
    expect(tools.has("t3_list_projects")).toBe(true);
    expect(tools.has("t3_list_environments")).toBe(true);
    expect(tools.has("t3_subscribe_events")).toBe(false);
    expect(tools.has("t3_control_thread")).toBe(true);
    for (const alias of SERVER_SUPERSEDED_TOOLS) expect(tools.has(alias)).toBe(false);
    const schema = tools.get("t3_get_thread")!.inputSchema as unknown as {
      properties: Record<string, unknown>;
      required?: Array<string>;
    };
    expect(schema.properties.environmentId).toBeDefined();
    expect(schema.required ?? []).not.toContain("environmentId");
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("runs tools on this environment when no other is reachable", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {});
    expect(result.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    expect(result.structuredContent).toMatchObject({ data: { items: [{ title: "kaizen" }] } });
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("refuses chats whose credential lacks orchestration", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {}, ["preview"]);
    expect(result.isError).toBe(true);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("refuses environments no connected app grants", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", { environmentId: remoteId });
    expect(result.isError).toBe(true);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("reaches granted environments through the connected app", () => {
  const listedFor: Array<string> = [];
  const relayed: Array<{ method: string; args: unknown }> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {});
    expect(result.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    expect(relayed).toEqual([
      { method: "listEnvironments", args: [] },
      { method: "listProjects", args: [remoteId] },
    ]);
    const [text] = result.content as ReadonlyArray<{ readonly text: string }>;
    expect(text!.text).toContain("kaizen");
    expect(text!.text).toContain("remote-app");
  }).pipe(Effect.provide(makeLayer(listedFor, relayed)));
});

it.effect("schedules on this chat's environment while another device's app is connected", () => {
  const relayed: Array<{ method: string; args: unknown }> = [];
  const scheduledOn: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_create_scheduled_task", {
      prompt: "Review what the agents did today.",
      profileId: "reviewer",
      projectId: "project-1",
      cron: "0 4 * * *",
      timezone: "Asia/Bangkok",
    });
    expect(result.isError).toBe(false);
    expect(scheduledOn).toEqual([localId]);
    expect(relayed).toEqual([]);
  }).pipe(Effect.provide(makeLayer([], relayed, scheduledOn)));
});

it.effect("lets a read-only client read but not change anything", () => {
  const listedFor: Array<string> = [];
  const scheduledOn: Array<string> = [];
  return Effect.gen(function* () {
    const read = yield* callTool(
      "t3_list_projects",
      { environmentId: localId },
      ["orchestration"],
      readOnlyClient,
    );
    expect(read.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    const write = yield* callTool(
      "t3_create_scheduled_task",
      {
        environmentId: localId,
        prompt: "Review what the agents did today.",
        profileId: "reviewer",
        projectId: "project-1",
        cron: "0 4 * * *",
        timezone: "Asia/Bangkok",
      },
      ["orchestration"],
      readOnlyClient,
    );
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write.structuredContent)).toContain("read-only access");
    expect(scheduledOn).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor, undefined, scheduledOn)));
});
