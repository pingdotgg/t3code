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

const SupportServicesLive = Layer.mergeAll(
  PreviewAutomationBroker.layer,
  McpSessionRegistry.layer,
).pipe(
  Layer.provideMerge(ServerEnvironmentTest),
  Layer.provideMerge(NodeHttpServer.layerTest),
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
  readonly result: (event: Extract<PreviewAutomationStreamEvent, { type: "request" }>) => unknown;
}) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const received: RegisteredHost["received"] = [];
  const events = yield* broker.connect({ clientId: input.clientId, environmentId });
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
          result: () => ({ acknowledged: "background" }),
        });
        const visible = yield* registerHost({
          clientId: "host-visible",
          result: (event) =>
            event.request.operation === "status"
              ? {
                  available: true,
                  visible: true,
                  tabId: visibleTabId,
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                }
              : { acknowledged: "visible" },
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
        const credential = yield* registry.issue({ threadId, providerInstanceId });
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

        const call = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization,
            "mcp-session-id": sessionId!,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"preview_status","arguments":{}}}`,
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

        // The visible host is the one that served the provider-scoped request.
        expect(visible.received.map(({ operation }) => operation)).toEqual(["status"]);
        expect(background.received).toEqual([]);
      }),
    ).pipe(Effect.provide(SupportServicesLive)),
);
