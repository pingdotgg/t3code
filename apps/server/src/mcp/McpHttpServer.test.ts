import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
const invalidCrcPng = Buffer.from(png);
invalidCrcPng.writeUInt32BE(0, 29);
const missingPixelsPng = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
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
  initializePayload: {
    protocolVersion: "2025-03-26",
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

it("filters tools/list independently by credential capability", async () => {
  const response = HttpServerResponse.jsonUnsafe({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [{ name: "preview_open" }, { name: "device_list" }, { name: "device_close" }],
    },
  });
  const disabled = McpHttpServer.filterAdvertisedToolsForTest(response, new Set(["preview"]));
  const deviceOnly = McpHttpServer.filterAdvertisedToolsForTest(response, new Set(["device"]));
  const enabled = McpHttpServer.filterAdvertisedToolsForTest(
    response,
    new Set(["preview", "device"]),
  );
  const decode = (value: typeof response) =>
    JSON.parse(new TextDecoder().decode((value.body as { body: Uint8Array }).body)) as {
      readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
    };
  expect(decode(disabled).result.tools.map((tool) => tool.name)).toEqual(["preview_open"]);
  expect(decode(deviceOnly).result.tools.map((tool) => tool.name)).toEqual([
    "device_list",
    "device_close",
  ]);
  expect(decode(enabled).result.tools.map((tool) => tool.name)).toEqual([
    "preview_open",
    "device_list",
    "device_close",
  ]);
});

it.each([
  { data: "", width: 0, height: 0 },
  { data: Buffer.from("not a png").toString("base64"), width: 1280, height: 800 },
  { data: png.toString("base64"), width: 1280, height: 800 },
  { data: png.subarray(0, 33).toString("base64"), width: 1, height: 1 },
  { data: invalidCrcPng.toString("base64"), width: 1, height: 1 },
  { data: missingPixelsPng.toString("base64"), width: 1, height: 1 },
  { data: png.toString("base64"), width: 100_000, height: 100_000 },
])(
  "reports invalid screenshot pixels as failure while retaining diagnostics",
  async (screenshot) => {
    const result = await McpHttpServer.encodePreviewSnapshotResult({
      visibleText: "Pair with this environment",
      consoleEntries: [
        { level: "error", text: "Expected page diagnostic", timestamp: "2026-09-24T00:00:00Z" },
      ],
      networkEntries: [
        {
          url: "https://example.com/resource",
          method: "GET",
          status: 503,
          failed: true,
          timestamp: "2026-09-24T00:00:00Z",
        },
      ],
      actionTimeline: [
        {
          id: "browser-action-test",
          action: "snapshot",
          status: "succeeded",
          startedAt: "2026-09-24T00:00:00Z",
        },
      ],
      screenshot: { mimeType: "image/png", ...screenshot },
    });
    expect(result.isError).toBe(true);
    expect(result.content.some((item) => item.type === "image")).toBe(false);
    expect(result.structuredContent).toMatchObject({
      visibleText: "Pair with this environment",
      consoleEntries: [{ text: "Expected page diagnostic" }],
      networkEntries: [{ url: "https://example.com/resource", status: 503 }],
      actionTimeline: [{ action: "snapshot" }],
      error: { _tag: "PreviewScreenshotInvalid" },
    });
  },
);

it("persists the screenshot when save is requested", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "t3-snapshot-save-test-"));
  const result = await McpHttpServer.encodePreviewSnapshotResult(
    {
      url: "https://example.com",
      title: "Example",
      visibleText: "hello",
      screenshot: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 },
    },
    { save: true, evidenceDir },
  );
  expect(result.isError).toBe(false);
  const structured = result.structuredContent as { screenshotPath?: unknown };
  expect(typeof structured.screenshotPath).toBe("string");
  const screenshotPath = structured.screenshotPath as string;
  expect(screenshotPath.startsWith(evidenceDir)).toBe(true);
  const saved = await readFile(screenshotPath);
  expect(saved.equals(png)).toBe(true);
});

it("omits screenshotPath without save and enforces the final text budget", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "t3-snapshot-budget-test-"));
  const oversized = "x".repeat(200_000);
  const unsaved = await McpHttpServer.encodePreviewSnapshotResult(
    {
      url: "https://example.com",
      title: "Example",
      visibleText: oversized,
      screenshot: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 },
    },
    { evidenceDir },
  );
  expect(unsaved.isError).toBe(false);
  expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");
  const text = unsaved.content.find((item) => item.type === "text") as { text: string };
  expect(text.text.length).toBeLessThanOrEqual(60_000);

  const saved = await McpHttpServer.encodePreviewSnapshotResult(
    {
      url: "https://example.com",
      title: "Example",
      visibleText: oversized,
      screenshot: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 },
    },
    { save: true, evidenceDir },
  );
  expect(saved.isError).toBe(false);
  expect(saved.structuredContent).toHaveProperty("screenshotPath");
  const savedText = saved.content.find((item) => item.type === "text") as { text: string };
  expect(savedText.text.length).toBeLessThanOrEqual(60_000);
  const screenshotPath = (saved.structuredContent as { screenshotPath: string }).screenshotPath;
  expect((await stat(screenshotPath)).isFile()).toBe(true);
});

it("never trusts a host-provided screenshotPath", async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "t3-snapshot-host-path-test-"));
  const result = await McpHttpServer.encodePreviewSnapshotResult(
    {
      url: "https://example.com",
      title: "Example",
      visibleText: "hello",
      screenshotPath: "/host-only/evil.png",
      screenshot: { mimeType: "image/png", data: png.toString("base64"), width: 1, height: 1 },
    },
    { evidenceDir },
  );
  expect(result.isError).toBe(false);
  expect(result.structuredContent).not.toHaveProperty("screenshotPath");
  const text = result.content.find((item) => item.type === "text") as { text: string };
  expect(text.text).not.toContain("/host-only/evil.png");
});

it("reports screenshot capture failures as typed errors while retaining diagnostics", async () => {
  const result = await McpHttpServer.encodePreviewSnapshotResult({
    visibleText: "Rendered page diagnostics",
    consoleEntries: [{ level: "warn", text: "Page warning", timestamp: "2026-09-24T00:00:00Z" }],
    networkEntries: [
      {
        url: "https://example.com/resource",
        method: "GET",
        status: null,
        failed: true,
        timestamp: "2026-09-24T00:00:00Z",
      },
    ],
    screenshot: { mimeType: "image/png", data: "", width: 0, height: 0 },
    screenshotCaptureFailure: {
      _tag: "PreviewScreenshotCaptureFailed",
      operation: "Page.captureScreenshot",
    },
  });

  expect(result.isError).toBe(true);
  expect(result.content.some((item) => item.type === "image")).toBe(false);
  expect(result.structuredContent).toMatchObject({
    visibleText: "Rendered page diagnostics",
    consoleEntries: [{ text: "Page warning" }],
    networkEntries: [{ url: "https://example.com/resource", failed: true }],
    error: {
      _tag: "PreviewScreenshotCaptureFailed",
      operation: "Page.captureScreenshot",
      message: expect.stringContaining("visual validation did not pass"),
    },
  });
});

it("returns an actionable expired-session response with a Bearer challenge", () => {
  expect(McpHttpServer.invalidMcpCredentialResponse.status).toBe(401);
  expect(McpHttpServer.invalidMcpCredentialResponse.headers["www-authenticate"]).toBe("Bearer");
  expect(McpHttpServer.invalidMcpCredentialBody).toEqual({
    error: "invalid_mcp_credential",
    recovery: "reconnect-required",
    message:
      "The T3 Code MCP session credential is invalid or expired. Restart the chat/session to reconnect browser automation.",
  });
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

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
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

it.effect("transfers finished recordings to the server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceDir = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "t3-recording-transfer-test-")),
      );
      process.env["T3CODE_BROWSER_EVIDENCE_DIR"] = evidenceDir;
      try {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const recordingBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
        const artifact = {
          id: "browser-recording-test",
          tabId,
          path: "/host-only/browser-recording-test.webm",
          mimeType: "video/webm",
          sizeBytes: recordingBytes.length,
          createdAt: "2026-09-16T00:00:00.000Z",
        };
        const events = yield* broker.connect({
          clientId: "mcp-recording-client",
          environmentId,
          supportedOperations: ["recordingStart", "recordingStop", "recordingTransfer"],
        });
        yield* Stream.runForEach(events, (event) => {
          if (event.type === "connected") return Effect.void;
          if (event.request.operation === "recordingTransfer") {
            return broker.respond({
              clientId: "mcp-recording-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: { ...artifact, data: recordingBytes.toString("base64") },
            });
          }
          return broker.respond({
            clientId: "mcp-recording-client",
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: artifact,
          });
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const stopped = yield* server
          .callTool({ name: "preview_recording_stop", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(stopped.isError).toBe(false);
        const structured = stopped.structuredContent as {
          path: string;
          transferred?: boolean;
        };
        expect(structured.transferred).toBe(true);
        expect(structured.path.startsWith(evidenceDir)).toBe(true);
        expect(structured.path.endsWith(".webm")).toBe(true);
        const saved = yield* Effect.promise(() => readFile(structured.path));
        expect(Buffer.from(saved).equals(recordingBytes)).toBe(true);
      } finally {
        delete process.env["T3CODE_BROWSER_EVIDENCE_DIR"];
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("falls back to the host-local recording path when transfer fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const artifact = {
        id: "browser-recording-fallback",
        tabId,
        path: "/host-only/browser-recording-fallback.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-16T00:00:00.000Z",
      };
      const events = yield* broker.connect({
        clientId: "mcp-recording-fallback-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        if (event.request.operation === "recordingTransfer") {
          return broker.respond({
            clientId: "mcp-recording-fallback-client",
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: false,
            error: { _tag: "PreviewAutomationExecutionError", message: "gone" },
          });
        }
        return broker.respond({
          clientId: "mcp-recording-fallback-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: artifact,
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const stopped = yield* server
        .callTool({ name: "preview_recording_stop", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(stopped.isError).toBe(false);
      expect(stopped.structuredContent).toMatchObject({ path: artifact.path });
    }),
  ).pipe(Effect.provide(TestLayer)),
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
                    data: png.toString("base64"),
                    width: 1,
                    height: 1,
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
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1, height: 1 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("exports an object-only no-argument tab listing and returns all tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const tabsTool = server.tools.find(({ tool }) => tool.name === "preview_tabs");
      expect(tabsTool?.tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tabsTool?.tool.inputSchema.properties ?? {}).toEqual({});
      expect(tabsTool?.tool.inputSchema.anyOf).toBeUndefined();
      expect(tabsTool?.tool.inputSchema.oneOf).toBeUndefined();

      const tabsResult = {
        tabs: [
          { tabId, url: "http://one.test/", title: "One", active: true, loading: false },
          {
            tabId: alternateTabId,
            url: "http://two.test/",
            title: "Two",
            active: false,
            loading: false,
          },
        ],
        activeTabId: tabId,
      };
      const requests: PreviewAutomationRequest[] = [];
      const events = yield* broker.connect({
        clientId: "mcp-tabs-client",
        environmentId,
        supportedOperations: ["listTabs"],
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        requests.push(event.request);
        return broker.respond({
          clientId: "mcp-tabs-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: tabsResult,
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const result = yield* server
        .callTool({ name: "preview_tabs", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(tabsResult);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ operation: "listTabs", input: {}, tabIdExplicit: false });
      expect(requests[0]?.tabId).toBeUndefined();
    }),
  ).pipe(Effect.provide(TestLayer)),
);
