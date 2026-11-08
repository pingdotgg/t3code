import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ComputerUse from "../computer/ComputerUse.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("environment-computer-test");
const threadId = ThreadId.make("thread-computer-test");
const threadCaller = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-computer-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-computer-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
// An outside OAuth client: it never holds `computer`, and acts as no thread.
const outsideClient = {
  ...threadCaller(["computer"]),
  thread: undefined,
  client: { sessionId: "client-session", label: "Outside client", access: "full-access" as const },
};
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

const acted: Array<unknown> = [];
const layerComputerMock = Layer.mock(ComputerUse.ComputerUse)({
  screenshot: () =>
    Effect.succeed({
      desktop: "KDE Plasma on test-host",
      displays: [{ index: 0, x: 0, y: 0, width: 1280, height: 800 }],
      display: null,
      screenshot: {
        mimeType: "image/png" as const,
        data: "iVBORw0KGgo=",
        width: 1280,
        height: 800,
      },
    }),
  act: (input) => Effect.sync(() => void acted.push(input)),
  stop: () => Effect.succeed({ stopped: true }),
});

const layerTest = McpHttpServer.layerComputerToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerComputerMock),
);

it.effect("serves desktop control only to thread callers holding the computer capability", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "computer_act",
      "computer_screenshot",
      "computer_stop",
    ]);
    const call = (
      name: string,
      args: Record<string, unknown>,
      caller: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const shot = yield* call("computer_screenshot", {}, threadCaller(["computer"]));
    expect(shot.isError).toBe(false);
    expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(shot.structuredContent).toMatchObject({
      desktop: "KDE Plasma on test-host",
      screenshot: { mimeType: "image/png", width: 1280, height: 800 },
    });

    const clicked = yield* call(
      "computer_act",
      { action: "click", x: 10, y: 20 },
      threadCaller(["computer"]),
    );
    expect(clicked.isError).toBe(false);
    expect(acted).toEqual([{ action: "click", x: 10, y: 20, threadId }]);

    const denied = yield* call(
      "computer_act",
      { action: "click", x: 1, y: 1 },
      threadCaller(["device"]),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([
      {
        type: "text",
        text: "Agent computer control is off for this agent session. Ask the user to turn it on in Settings > Devices; it applies when the agent session next starts, such as in a new thread.",
      },
    ]);
    const deniedShot = yield* call("computer_screenshot", {}, threadCaller([]));
    expect(deniedShot.isError).toBe(true);

    const outside = yield* call("computer_screenshot", {}, outsideClient);
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain("needs an agent running inside T3 Code");
    expect(acted).toHaveLength(1);
  }).pipe(Effect.provide(layerTest)),
);
