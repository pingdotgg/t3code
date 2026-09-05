import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, requireMcpCapability } from "./McpInvocationContext.ts";
import { MonitorToolkitRegistrationLive } from "./McpHttpServer.ts";
import { registerMonitorSession } from "./MonitorSession.ts";
import { CodexBackgroundTasks } from "../provider/Layers/CodexBackgroundTasks.ts";

const scope = {
  environmentId: EnvironmentId.make("monitor-test"),
  threadId: ThreadId.make("monitor-test"),
  providerSessionId: "monitor-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["monitor"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "monitor-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = MonitorToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("MCP subscription enables wakes and unsubscribe discards queued events", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tasks = new CodexBackgroundTasks();
    tasks.started({
      id: "watch",
      processId: "42",
      source: "unifiedExecStartup",
      command: "watch-ci",
    });
    yield* registerMonitorSession(scope.providerSessionId, {
      subscribe: (id) =>
        Effect.sync(() => {
          expect(tasks.subscribe(id)).toBe(true);
        }),
      unsubscribe: (id) => Effect.sync(() => tasks.unsubscribe(id)),
    });
    const call = (name: string) => server.callTool({ name, arguments: { processId: "42" } });
    expect((yield* call("monitor_subscribe")).isError).toBe(false);
    tasks.output("watch", "first event\n");
    expect(tasks.takeWake()?.output).toContain("first event");
    tasks.output("watch", "queued event\n");
    expect((yield* call("monitor_unsubscribe")).isError).toBe(false);
    tasks.output("watch", "later event\n");
    expect(tasks.takeWake()).toBeUndefined();
  }).pipe(
    Effect.scoped,
    Effect.provideService(McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(TestLayer),
  ),
);

it.effect("MCP tools reject other sessions, missing capability, and a closed runtime", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    let subscribed = false;
    const call = server.callTool({ name: "monitor_subscribe", arguments: { processId: "42" } });
    yield* Effect.gen(function* () {
      yield* registerMonitorSession(scope.providerSessionId, {
        subscribe: () =>
          Effect.sync(() => {
            subscribed = true;
          }),
        unsubscribe: () => Effect.void,
      });
      expect(
        (yield* call.pipe(
          Effect.provideService(McpInvocationContext, {
            ...scope,
            providerSessionId: "other-session",
          }),
        )).isError,
      ).toBe(true);
      expect(
        (yield* call.pipe(
          Effect.provideService(McpInvocationContext, {
            ...scope,
            capabilities: new Set(["preview"] as const),
          }),
        )).isError,
      ).toBe(true);
      expect(subscribed).toBe(false);
    }).pipe(Effect.scoped);
    expect((yield* call).isError).toBe(true);
  }).pipe(
    Effect.provideService(McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(TestLayer),
  ),
);

it.effect("a monitoring credential cannot invoke preview tools", () =>
  requireMcpCapability("preview").pipe(
    Effect.result,
    Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("Failure"))),
    Effect.provideService(McpInvocationContext, scope),
  ),
);
