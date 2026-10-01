import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { ManagedPreviewAuth } from "../auth/Services/ManagedPreviewAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-e2e");
const threadId = ThreadId.make("thread-e2e");
const providerInstanceId = ProviderInstanceId.make("copilot");
const visibleTabId = PreviewTabId.make("tab-visible-host");

const ServerEnvironmentTest = Layer.succeed(
  ServerEnvironment,
  ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("unused"),
  }),
);

const ManagedPreviewAuthTest = Layer.succeed(
  ManagedPreviewAuth,
  ManagedPreviewAuth.of({
    prepare: () => Effect.succeed(undefined),
    attest: () => Effect.succeed(undefined),
    openBootstrap: () => Effect.die("Managed preview bootstrap is unused in this test."),
    release: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const SupportServicesLive = Layer.mergeAll(
  PreviewAutomationBroker.layer.pipe(Layer.provide(ManagedPreviewAuthTest)),
  McpSessionRegistry.layer,
).pipe(
  Layer.provideMerge(ServerEnvironmentTest),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

const DeviceServiceTest = Layer.mock(DeviceService.DeviceService)({});
const DeviceSupportServicesLive = Layer.mergeAll(SupportServicesLive, DeviceServiceTest).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-schema-device-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

interface RegisteredHost {
  readonly clientId: string;
  readonly connectionId: string;
  readonly received: Array<{ readonly operation: string; readonly tabId?: string | undefined }>;
}

/**
 * Mirrors the web `PreviewAutomationHosts` consumer: register the Electron
 * webview host, then answer every routed automation request.
 */
const registerHost = Effect.fn("test.registerHost")(function* (input: {
  readonly clientId: string;
  readonly supportedOperations?: ReadonlyArray<"status" | "preflight" | "click">;
  readonly result: (event: Extract<PreviewAutomationStreamEvent, { type: "request" }>) => unknown;
}) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const received: RegisteredHost["received"] = [];
  const events = yield* broker.connect({
    clientId: input.clientId,
    environmentId,
    ...(input.supportedOperations ? { supportedOperations: input.supportedOperations } : {}),
  });
  const connectionIdDeferred: { current: string | undefined } = { current: undefined };
  yield* Stream.runForEach(events, (event) => {
    if (event.type === "connected") {
      connectionIdDeferred.current = event.connectionId;
      return Effect.void;
    }
    received.push(event.request);
    return broker.respond({
      clientId: input.clientId,
      connectionId: event.connectionId,
      requestId: event.request.requestId,
      ok: true,
      result: input.result(event),
    });
  }).pipe(Effect.forkScoped);
  yield* Effect.yieldNow;
  const connectionId = connectionIdDeferred.current;
  expect(connectionId).toBeDefined();
  return {
    clientId: input.clientId,
    connectionId: connectionId!,
    received,
  } satisfies RegisteredHost;
});

const parseMcpBody = (body: string): unknown => {
  const dataLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : body);
};

it.effect(
  "routes a provider-scoped MCP tool call over HTTP to the visible registered automation host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;

        const background = yield* registerHost({
          clientId: "host-background",
          supportedOperations: ["status"],
          result: () => ({ acknowledged: "background" }),
        });
        const visible = yield* registerHost({
          clientId: "host-visible",
          supportedOperations: ["status", "preflight", "click"],
          result: (event) => {
            if (event.request.operation === "status") {
              return {
                available: true,
                visible: true,
                tabId: visibleTabId,
                url: "http://example.test/",
                title: "Example",
                loading: false,
              };
            }
            if (event.request.operation === "preflight") {
              const input = event.request.input as { readonly open?: boolean };
              return input.open === true
                ? {
                    browser: {
                      supported: true,
                      available: true,
                      visible: true,
                      tabAttached: true,
                      tabId: visibleTabId,
                    },
                    mcp: { credential: "valid" },
                    target: {
                      requested: true,
                      reachability: "reachable",
                      app: "expected-t3-app",
                      origin: "http://example.test",
                      environmentId,
                      status: 200,
                    },
                    recovery: {
                      kind: "pair-after-preflight",
                      message: "The target is ready for pairing.",
                    },
                  }
                : {
                    browser: {
                      supported: true,
                      available: true,
                      visible: false,
                      tabAttached: false,
                      tabId: null,
                    },
                    mcp: { credential: "valid" },
                    target: {
                      requested: true,
                      reachability: "not-checked",
                      app: "unknown",
                      origin: null,
                      environmentId: null,
                      status: null,
                    },
                    recovery: {
                      kind: "open-browser",
                      message: "Open the collaborative browser.",
                    },
                  };
            }
            return { acknowledged: "visible" };
          },
        });

        // The desktop host reports visibility exactly like `focusHost` does
        // when the browser panel becomes the visible right panel.
        yield* broker.focusHost({
          clientId: visible.clientId,
          connectionId: visible.connectionId,
          environmentId,
          focused: true,
        });

        // Issued through the same path `ProviderService` uses when a provider
        // session starts, so the credential is provider-scoped.
        const credential = yield* registry.issue({
          threadId,
          providerInstanceId,
          capabilities: new Set(["preview", "terminal"]),
        });
        expect(credential.config.threadId).toBe(threadId);
        expect(credential.config.providerInstanceId).toBe(providerInstanceId);
        expect(credential.config.endpoint).toContain("/mcp");

        yield* HttpRouter.serve(McpHttpServer.layer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        const httpClient = yield* HttpClient.HttpClient;

        const unauthorized = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer not-a-real-credential",
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-e2e","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        expect(unauthorized.status).toBe(401);

        const authorization = credential.config.authorizationHeader;
        const initialize = yield* httpClient.post("/mcp", {
          headers: { accept: "application/json, text/event-stream", authorization },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-e2e","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        expect(initialize.status).toBe(200);
        const sessionId = initialize.headers["mcp-session-id"];
        expect(sessionId).toBeDefined();

        yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
            "application/json",
          ),
        });

        const toolsList = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
            "application/json",
          ),
        });
        expect(toolsList.status).toBe(200);
        const toolsPayload = parseMcpBody(yield* toolsList.text) as {
          readonly result?: unknown;
        };
        const tools = ListToolsResultSchema.parse(toolsPayload.result);
        expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

        const call = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"preview_status","arguments":{}}}`,
            "application/json",
          ),
        });
        expect(call.status).toBe(200);
        const payload = parseMcpBody(yield* call.text) as {
          readonly result?: {
            readonly isError?: boolean;
            readonly structuredContent?: Record<string, unknown>;
          };
        };
        expect(payload.result?.isError).toBeFalsy();
        expect(payload.result?.structuredContent).toMatchObject({
          available: true,
          visible: true,
          tabId: visibleTabId,
        });

        const preflightClosed = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"preview_preflight","arguments":{"url":"http://example.test/pair?token=secret-token","open":false}}}`,
            "application/json",
          ),
        });
        const closedPayload = parseMcpBody(yield* preflightClosed.text) as {
          readonly result?: { readonly structuredContent?: Record<string, unknown> };
        };
        expect(closedPayload.result?.structuredContent).toMatchObject({
          browser: { tabAttached: false },
          recovery: { kind: "open-browser" },
        });
        expect(JSON.stringify(closedPayload)).not.toContain("secret-token");

        const preflightReady = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"preview_preflight","arguments":{"url":"http://example.test/pair?token=secret-token","open":true}}}`,
            "application/json",
          ),
        });
        const readyPayload = parseMcpBody(yield* preflightReady.text) as {
          readonly result?: { readonly structuredContent?: Record<string, unknown> };
        };
        expect(readyPayload.result?.structuredContent).toMatchObject({
          browser: { tabAttached: true },
          target: {
            app: "expected-t3-app",
            environmentId,
          },
          recovery: { kind: "pair-after-preflight" },
        });
        expect(JSON.stringify(readyPayload)).not.toContain("secret-token");

        const click = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"preview_click","arguments":{"selector":"#example"}}}`,
            "application/json",
          ),
        });
        const clickPayload = parseMcpBody(yield* click.text) as {
          readonly result?: {
            readonly isError?: boolean;
            readonly structuredContent?: unknown;
          };
        };
        expect(clickPayload.result?.isError).toBeFalsy();
        // Strict MCP clients validate `structuredContent` as a record: a
        // null payload fails them even though the click itself succeeded.
        expect(clickPayload.result?.structuredContent).toEqual({ ok: true });

        // The visible host is the one that served the provider-scoped request.
        expect(visible.received.map(({ operation }) => operation)).toEqual([
          "status",
          "preflight",
          "preflight",
          "click",
        ]);
        expect(background.received).toEqual([]);
      }),
    ).pipe(Effect.provide(SupportServicesLive)),
);

it.effect("advertises SDK-valid tool schemas from the device-enabled MCP HTTP layer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const credential = yield* registry.issue({
        threadId,
        providerInstanceId,
        capabilities: new Set(["preview", "terminal", "device"]),
      });

      yield* HttpRouter.serve(McpHttpServer.layerWithDevice, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const authorization = credential.config.authorizationHeader;
      const initialize = yield* httpClient.post("/mcp-device", {
        headers: { accept: "application/json, text/event-stream", authorization },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-e2e","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers["mcp-session-id"];
      expect(sessionId).toBeDefined();

      yield* httpClient.post("/mcp-device", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","method":"notifications/initialized"}`,
          "application/json",
        ),
      });

      const toolsList = yield* httpClient.post("/mcp-device", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      expect(toolsList.status).toBe(200);
      const toolsPayload = parseMcpBody(yield* toolsList.text) as {
        readonly result?: unknown;
      };
      const tools = ListToolsResultSchema.parse(toolsPayload.result);
      expect(tools.tools.some((tool) => tool.name === "device_list")).toBe(true);
      expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    }),
  ).pipe(Effect.provide(DeviceSupportServicesLive)),
);
