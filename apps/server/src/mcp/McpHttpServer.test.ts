import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationElement,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const snapshotFixture = (
  overrides: Partial<PreviewAutomationSnapshot> = {},
): PreviewAutomationSnapshot => ({
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
  ...overrides,
});
const element = (name: string): PreviewAutomationElement => ({
  tag: "button",
  role: null,
  name,
  selector: "button",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});
const serializedByteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

it("passes snapshot metadata through untouched while it fits", () => {
  const snapshot = snapshotFixture({ accessibilityTree: { nodes: [{ role: "main" }] } });
  const { metadata, serialized } = McpHttpServer.boundPreviewSnapshotMetadata(snapshot);

  expect(metadata).not.toHaveProperty("truncation");
  expect(metadata).toMatchObject({
    accessibilityTree: { nodes: [{ role: "main" }] },
    screenshot: { mimeType: "image/png", width: 10, height: 5 },
  });
  expect(metadata.screenshot).not.toHaveProperty("data");
  expect(serialized).toBe(JSON.stringify(metadata));
});

it("drops the accessibility tree first and keeps the rest of an oversized snapshot", () => {
  const snapshot = snapshotFixture({
    visibleText: "visible ".repeat(2_000),
    interactiveElements: [element("Save")],
    consoleEntries: [{ level: "log", text: "hello", timestamp: "2026-09-04T00:00:00Z" }],
    accessibilityTree: { nodes: [{ name: "accessible ".repeat(50_000) }] },
  });
  const { metadata, serialized } = McpHttpServer.boundPreviewSnapshotMetadata(snapshot);

  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
    McpHttpServer.PREVIEW_SNAPSHOT_METADATA_MAX_BYTES,
  );
  expect(metadata.accessibilityTree).toBeNull();
  expect(metadata.truncation).toEqual({
    originalBytes: serializedByteLength({
      ...snapshot,
      screenshot: { mimeType: "image/png", width: 10, height: 5 },
    }),
    omitted: ["accessibilityTree"],
    trimmed: [],
  });
  expect(metadata.visibleText).toBe(snapshot.visibleText);
  expect(metadata.interactiveElements).toEqual(snapshot.interactiveElements);
  expect(metadata.consoleEntries).toEqual(snapshot.consoleEntries);
  expect(parseJson(serialized)).toEqual(metadata);
});

it("cuts the visible text short before giving up the interactive elements", () => {
  // Multi-byte text: the byte budget, not the character count, is what has to fit.
  const snapshot = snapshotFixture({
    visibleText: "görünür metin 🙂 ".repeat(20_000),
    interactiveElements: [element("Save"), element("Cancel")],
    accessibilityTree: { nodes: [{ name: "accessible ".repeat(50_000) }] },
  });
  const { metadata, serialized } = McpHttpServer.boundPreviewSnapshotMetadata(snapshot);

  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
    McpHttpServer.PREVIEW_SNAPSHOT_METADATA_MAX_BYTES,
  );
  expect(metadata.truncation).toMatchObject({
    omitted: ["accessibilityTree"],
    trimmed: ["visibleText"],
  });
  expect(metadata.visibleText.length).toBeGreaterThan(0);
  expect(metadata.visibleText.isWellFormed()).toBe(true);
  expect(snapshot.visibleText.startsWith(metadata.visibleText)).toBe(true);
  expect(metadata.interactiveElements).toEqual(snapshot.interactiveElements);
});

it("gives up the interactive elements last when they alone exceed the limit", () => {
  const snapshot = snapshotFixture({
    visibleText: "visible ".repeat(2_000),
    interactiveElements: [element("x".repeat(200_000))],
  });
  const { metadata, serialized } = McpHttpServer.boundPreviewSnapshotMetadata(snapshot);

  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
    McpHttpServer.PREVIEW_SNAPSHOT_METADATA_MAX_BYTES,
  );
  expect(metadata.interactiveElements).toEqual([]);
  // Empty logs are not reported as omitted: only what the agent actually lost is listed.
  expect(metadata.truncation?.omitted).toEqual(["accessibilityTree", "interactiveElements"]);
  expect(metadata.truncation?.trimmed).toEqual(["visibleText"]);
  expect(metadata.visibleText).toBe("");
});

it.effect("returns bounded preview snapshot metadata with the screenshot and a note", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-oversized-snapshot-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-oversized-snapshot-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: snapshotFixture({
                url: "http://example.test/large",
                title: "Large page",
                interactiveElements: [element("Save")],
                accessibilityTree: { nodes: [{ name: "accessible ".repeat(50_000) }] },
              }),
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(false);
      const texts = snapshot.content.flatMap((content) =>
        content.type === "text" ? [content.text] : [],
      );
      expect(texts).toHaveLength(2);
      expect(Buffer.byteLength(texts[0]!, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.PREVIEW_SNAPSHOT_METADATA_MAX_BYTES,
      );
      expect(parseJson(texts[0]!)).toEqual(snapshot.structuredContent);
      expect(texts[1]).toContain("Omitted: accessibilityTree.");
      expect(snapshot.structuredContent).toMatchObject({
        title: "Large page",
        accessibilityTree: null,
        interactiveElements: [element("Save")],
        truncation: { omitted: ["accessibilityTree"], trimmed: [] },
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
