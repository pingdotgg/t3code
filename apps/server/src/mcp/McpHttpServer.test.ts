// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeVM from "node:vm";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
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
const PreviewTestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
);
const TestLayer = PreviewTestLayer.pipe(Layer.provideMerge(NodeServices.layer));
const PullRequestsTestLayer = McpHttpServer.PullRequestsToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      NodeServices.layer,
    ),
  ),
);

const snapshotResult = {
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
};

/** Answers every snapshot request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const callReadText = (args: Record<string, unknown>, scope = invocation) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_read_text", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const serveTextCaptures = (
  clientId: string,
  text: string,
  options: {
    switchTab?: boolean;
    snapshotFailure?: boolean;
    beforeSnapshot?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const switched = yield* Deferred.make<void>();
    const requests: PreviewAutomationRequest[] = [];
    const timers = new Set<() => void>();
    const listeners = new Map<string, () => void>();
    let textReads = 0;
    const context = NodeVM.createContext({
      TextEncoder,
      document: {
        body: {
          get innerText() {
            textReads++;
            return text;
          },
        },
      },
      location: { href: snapshotResult.url },
      setTimeout: (callback: () => void) => {
        timers.add(callback);
        return callback;
      },
      clearTimeout: (callback: () => void) => timers.delete(callback),
      addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
      removeEventListener: (event: string, callback: () => void) => {
        if (listeners.get(event) === callback) listeners.delete(event);
      },
    });
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      requests.push(event.request);
      return Effect.gen(function* () {
        const request = event.request;
        let result: unknown = snapshotResult;
        if (request.operation === "snapshot") {
          if (options.beforeSnapshot) yield* options.beforeSnapshot;
          if (options.snapshotFailure) {
            yield* broker.respond({
              clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "private snapshot failure",
              },
            });
            return;
          }
        }
        if (request.operation === "status") {
          result = {
            available: true,
            visible: true,
            tabId: request.tabId === alternateTabId ? alternateTabId : tabId,
            url: snapshotResult.url,
            title: snapshotResult.title,
            loading: false,
          };
        } else if (request.operation === "evaluate") {
          if (options.switchTab) yield* Deferred.await(switched);
          const expression = (request.input as { expression: string }).expression;
          try {
            result = NodeVM.runInContext(expression, context);
          } catch {
            yield* broker.respond({
              clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "private renderer failure",
              },
            });
            return;
          }
        }
        yield* broker.respond({
          clientId,
          connectionId: event.connectionId,
          requestId: request.requestId,
          ok: true,
          result,
        });
        if (
          options.switchTab &&
          request.operation === "status" &&
          request.tabId !== alternateTabId
        ) {
          yield* broker.invoke({
            scope: invocation,
            operation: "status",
            tabId: alternateTabId,
            input: {},
          });
          yield* Deferred.succeed(switched, undefined);
        }
      }).pipe(Effect.forkScoped, Effect.asVoid);
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return { requests, context, timers, listeners, textReads: () => textReads };
  });

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

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
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
          .callTool({ name: "preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        const message = "Preview automation snapshot failed on client mcp-failure-client.";
        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: `Preview snapshot failed: ${message}` },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
            message,
          },
        });
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { args: {}, advice: "No active preview tab was found for snapshot. Call preview_open first." },
  {
    args: { tabId: alternateTabId },
    advice: `Preview tab ${alternateTabId} was not found for snapshot. Omit tabId to use the current tab, or call preview_open.`,
  },
])("tells the agent to open a tab when the snapshot has none $args", ({ args, advice }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const events = yield* broker.connect({ clientId: "mcp-no-tab-client", environmentId });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Deferred.succeed(connected, undefined)
          : broker.respond({
              clientId: "mcp-no-tab-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: { _tag: "PreviewAutomationTabNotFoundError", message: "no tab" },
            }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const snapshot = yield* callSnapshot(args);

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: `Preview snapshot failed: ${advice}` },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([{}, { captureText: true }])(
  "tells the agent how to fall back when no desktop app can run the snapshot %j",
  (args) =>
    Effect.gen(function* () {
      const snapshot = yield* callSnapshot(args);

      expect(snapshot.isError).toBe(true);
      const [text] = snapshot.content;
      expect(text?.type === "text" ? text.text : "").toContain(
        "use a headless browser from the shell",
      );
      expect(snapshot.structuredContent).toMatchObject({
        error: { _tag: "PreviewAutomationNoAvailableHostError" },
      });
    }).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { mode: "default", input: {}, images: true },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({});
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual({
          ...boundedMetadata,
          omitted: ["accessibilityTree (use interactiveElements locators or preview_evaluate)"],
        });
        const [identity, text, ...rest] = snapshot.content;
        expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
          url: page.url,
        });
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: "Snapshot text was bounded. Omitted: accessibilityTree (use interactiveElements locators or preview_evaluate).",
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      // Output selection belongs to this call, not the MCP session's history.
      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual([
        "text",
        "text",
        "text",
        "image",
      ]);
      expect(nextDefault.structuredContent).toMatchObject({ title: "Snapshot 7", screenshot });
      expect(nextDefault.structuredContent).not.toHaveProperty("accessibilityTree");
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["includeImage", "captureText"])(
  "rejects non-boolean snapshot %s options before selecting a browser host",
  (option) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const value of ["false", 0, null]) {
        const result = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { [option]: value },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          { type: "text", text: "Preview snapshot failed: AiError." },
        ]);
        expect(result.structuredContent).toEqual({
          error: { _tag: "AiError", operation: "snapshot", failureCount: 1 },
        });
      }
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("accepts a snapshot call with the arguments field omitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inputs = yield* serveSnapshots("mcp-omitted-snapshot-arguments-client", snapshotResult);
      const server = yield* McpServer.McpServer;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot" })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(false);
      expect(inputs).toEqual([{}]);
      expect(snapshot.structuredContent).toMatchObject({
        url: snapshotResult.url,
        title: snapshotResult.title,
        visibleText: snapshotResult.visibleText,
      });
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("saves the snapshot PNG on request and reports its path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputs = yield* serveSnapshots("mcp-save-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(false);
      // The browser never receives the server-only `save` flag.
      expect(inputs).toEqual([{}]);
      const structured = snapshot.structuredContent as { readonly screenshotPath?: string };
      const screenshotPath = structured.screenshotPath;
      expect(typeof screenshotPath).toBe("string");
      expect(path.dirname(screenshotPath!)).toBe(config.browserArtifactsDir);
      expect(path.basename(screenshotPath!)).toMatch(
        /^browser-screenshot-example-test-[0-9a-z]+-[0-9a-f]{8}\.png$/,
      );
      expect(Buffer.from(yield* fileSystem.readFile(screenshotPath!)).toString()).toBe("png");
      const [, text] = snapshot.content;
      expect(text?.type === "text" ? decodeJsonText(text.text) : null).toMatchObject({
        screenshotPath,
      });

      const unsaved = yield* callSnapshot({});
      expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");

      // A save without the image skips the page dump.
      const pathOnly = yield* callSnapshot({ save: true, includeImage: false });
      const saved = pathOnly.structuredContent as { readonly screenshotPath: string };
      expect(saved).toEqual({ url: snapshotResult.url, screenshotPath: expect.any(String) });
      expect(Buffer.from(yield* fileSystem.readFile(saved.screenshotPath)).toString()).toBe("png");
      const [only, ...others] = pathOnly.content;
      expect(others).toEqual([]);
      expect(only?.type === "text" ? decodeJsonText(only.text) : null).toEqual(saved);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a tagged error when the screenshot cannot be saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A regular file where the artifacts directory should be makes every write fail.
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { save: false, includeImage: false },
  { save: true, includeImage: false },
  { save: true, includeImage: true },
])("reads complete loaded text from memory with snapshot options %j", (options) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const loadedText = "a".repeat(4095) + "😀中文\n".repeat(12_000) + "Offscreen loaded end";
      const host = yield* serveTextCaptures("mcp-text-capture-client", loadedText, {
        switchTab: true,
      });

      const snapshot = yield* callSnapshot({ captureText: true, ...options });

      expect(snapshot.isError).toBe(false);
      const captured = snapshot.structuredContent as {
        readonly textCaptureId: string;
        readonly textTabId: string;
        readonly screenshotPath?: string;
      };
      expect(captured).toMatchObject({
        textCaptureId: expect.any(String),
        textChars: loadedText.length,
        textUrl: snapshotResult.url,
        textTabId: tabId,
      });
      expect(captured).not.toHaveProperty("textPath");
      expect(captured).not.toHaveProperty("textBytes");
      expect(host.textReads()).toBe(1);
      const beforeRead = [...host.requests];
      expect(beforeRead.filter((request) => request.operation === "status")).toHaveLength(2);
      const pageRequests = beforeRead.filter((request) => request.operation !== "status");
      expect(pageRequests.every((request) => request.tabId === tabId)).toBe(true);
      expect(pageRequests.filter((request) => request.operation === "snapshot")).toEqual([
        expect.objectContaining({ operation: "snapshot", input: {} }),
      ]);
      expect(beforeRead.length).toBeLessThan(8);
      const texts = snapshot.content.filter((content) => content.type === "text");
      const metadata = texts[options.save && !options.includeImage ? 0 : 1];
      expect(metadata?.type === "text" ? decodeJsonText(metadata.text) : null).toMatchObject({
        textCaptureId: captured.textCaptureId,
        textChars: loadedText.length,
        textUrl: snapshotResult.url,
        textTabId: tabId,
      });
      expect(
        metadata?.type === "text" ? Buffer.byteLength(metadata.text, "utf8") : Infinity,
      ).toBeLessThanOrEqual(McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES);
      expect(encodeJsonText(captured)).not.toContain("Offscreen loaded end");
      expect(snapshot.content.some((content) => content.type === "image")).toBe(
        options.includeImage,
      );
      if (options.save) {
        expect(path.dirname(captured.screenshotPath!)).toBe(config.browserArtifactsDir);
        expect(Buffer.from(yield* fs.readFile(captured.screenshotPath!)).toString()).toBe("png");
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([
          path.basename(captured.screenshotPath!),
        ]);
      } else {
        expect(captured).not.toHaveProperty("screenshotPath");
        expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
      }
      if (options.save && !options.includeImage) {
        expect(Object.keys(captured).sort()).toEqual([
          "screenshotPath",
          "textCaptureId",
          "textChars",
          "textTabId",
          "textUrl",
          "url",
        ]);
        expect(snapshot.content).toHaveLength(1);
      }

      let offset = 0;
      let complete = "";
      while (offset < loadedText.length) {
        const result = yield* callReadText({
          captureId: captured.textCaptureId,
          tabId: captured.textTabId,
          offset,
        });
        expect(result.isError).toBe(false);
        const chunk = result.structuredContent as {
          readonly text: string;
          readonly nextOffset: number;
          readonly totalChars: number;
          readonly done: boolean;
          readonly released: boolean;
        };
        expect(chunk.text.length).toBeLessThanOrEqual(4096);
        expect(chunk.nextOffset).toBe(offset + chunk.text.length);
        expect(chunk.nextOffset).toBeGreaterThan(offset);
        expect(chunk.totalChars).toBe(loadedText.length);
        expect(chunk.done).toBe(chunk.nextOffset === loadedText.length);
        expect(chunk.released).toBe(false);
        expect(chunk.text.isWellFormed()).toBe(true);
        const [content] = result.content;
        expect(content?.type === "text" ? decodeJsonText(content.text) : null).toEqual(chunk);
        expect(Buffer.byteLength(encodeJsonText(chunk))).toBeLessThan(25_000);
        complete += chunk.text;
        offset = chunk.nextOffset;
      }
      expect(complete).toBe(loadedText);
      expect(host.textReads()).toBe(1);
      expect(
        host.requests
          .slice(beforeRead.length)
          .every((request) => request.operation === "evaluate" && request.tabId === tabId),
      ).toBe(true);
      expect(host.timers.size).toBe(1);

      const released = yield* callReadText({
        captureId: captured.textCaptureId,
        tabId: captured.textTabId,
        release: true,
      });
      expect(released.isError).toBe(false);
      expect(released.structuredContent).toEqual({
        text: "",
        nextOffset: 0,
        totalChars: loadedText.length,
        done: true,
        released: true,
      });
      expect(host.timers.size).toBe(0);
      expect(host.listeners.size).toBe(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([{}, { captureText: false }])("keeps full-text capture opt-in %j", (options) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-text-not-requested-client", "Loaded text");

      const snapshot = yield* callSnapshot({ ...options, includeImage: false });

      expect(snapshot.isError).toBe(false);
      expect(host.requests).toHaveLength(1);
      expect(host.requests[0]).toMatchObject({ operation: "snapshot", input: {} });
      expect(host.textReads()).toBe(0);
      expect(snapshot.structuredContent).not.toHaveProperty("textCaptureId");
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects an invalid snapshot before starting a requested text capture", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-invalid-text-capture-client", "Loaded text");

      const snapshot = yield* callSnapshot({ captureText: true, includeImage: "wrong" });

      expect(snapshot.isError).toBe(true);
      expect(host.requests).toEqual([]);
      expect(host.textReads()).toBe(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["navigation", "reload"] as const)(
  "does not return captured text from the old page after %s before snapshot",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const options: { beforeSnapshot?: Effect.Effect<void> } = {};
        const host = yield* serveTextCaptures(
          "mcp-capture-page-change-client",
          "loaded text",
          options,
        );
        options.beforeSnapshot = Effect.sync(() => {
          expect(host.timers.size).toBe(1);
          if (change === "navigation")
            NodeVM.runInContext("location.href = 'https://other.test/'", host.context);
          else host.listeners.get("pagehide")!();
        });

        const snapshot = yield* callSnapshot({ captureText: true });

        expect(snapshot.isError).toBe(true);
        expect(snapshot.content.every((content) => content.type === "text")).toBe(true);
        expect(snapshot.structuredContent).not.toHaveProperty("textCaptureId");
        expect(host.requests.filter((request) => request.operation === "snapshot")).toHaveLength(1);
        expect(host.timers.size).toBe(0);
        expect(host.listeners.size).toBe(0);
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("releases the text capture when the following snapshot fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-capture-snapshot-failure-client", "loaded text", {
        snapshotFailure: true,
      });

      const snapshot = yield* callSnapshot({ captureText: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        error: { _tag: "PreviewAutomationExecutionError", operation: "snapshot" },
      });
      expect(snapshot.content.every((content) => content.type === "text")).toBe(true);
      expect(host.requests.filter((request) => request.operation === "snapshot")).toHaveLength(1);
      expect(host.textReads()).toBe(1);
      expect(host.timers.size).toBe(0);
      expect(host.listeners.size).toBe(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(config.browserArtifactsDir)).toBe(false);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("releases its text capture when saving the PNG fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(config.browserArtifactsDir, "keep this file");
      const host = yield* serveTextCaptures("mcp-capture-png-failure-client", "loaded text");

      const snapshot = yield* callSnapshot({ captureText: true, save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot" },
      });
      expect(snapshot.content.every((content) => content.type === "text")).toBe(true);
      expect(host.textReads()).toBe(1);
      expect(host.timers.size).toBe(0);
      expect(host.listeners.size).toBe(0);
      expect(yield* fs.readFileString(config.browserArtifactsDir)).toBe("keep this file");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("releases the text capture when the following snapshot is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const enteredSnapshot = yield* Deferred.make<void>();
      const host = yield* serveTextCaptures("mcp-capture-snapshot-cancel-client", "loaded text", {
        beforeSnapshot: Deferred.succeed(enteredSnapshot, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
      });
      const fiber = yield* Effect.forkChild(callSnapshot({ captureText: true }));
      yield* Deferred.await(enteredSnapshot);
      expect(host.timers.size).toBe(1);

      yield* Fiber.interrupt(fiber);

      expect(host.requests.filter((request) => request.operation === "snapshot")).toHaveLength(1);
      expect(host.textReads()).toBe(1);
      expect(host.timers.size).toBe(0);
      expect(host.listeners.size).toBe(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  {},
  { tabId },
  { captureId: "capture" },
  { tabId, captureId: "" },
  { tabId, captureId: 1 },
  { tabId, captureId: "capture", offset: -1 },
  { tabId, captureId: "capture", offset: 0.5 },
  { tabId, captureId: "capture", offset: "0" },
  { tabId, captureId: "capture", release: "true" },
])("rejects invalid read-text parameters before browser dispatch %j", (args) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-invalid-text-read-client", "Loaded text");

      const result = yield* callReadText(args);

      expect(result.isError).toBe(true);
      expect(host.requests).toEqual([]);
      expect(encodeJsonText(result)).not.toContain("Loaded text");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("requires the preview capability before reading captured text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-denied-text-read-client", "Loaded text");
      const server = yield* McpServer.McpServer;

      const result = yield* server
        .callTool({ name: "preview_read_text", arguments: { tabId, captureId: "capture" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...invocation,
            capabilities: new Set<McpInvocationContext.McpCapability>(),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(result.isError).toBe(true);
      expect(encodeJsonText(result)).toContain("preview capability");
      expect(host.requests).toEqual([]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["navigation", "reload", "expiry", "replacement", "release"] as const)(
  "rejects a stale text capture after %s with useful guidance and no page text",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* serveTextCaptures("mcp-stale-text-read-client", "private loaded text");
        const snapshot = yield* callSnapshot({ captureText: true });
        const captured = snapshot.structuredContent as { readonly textCaptureId: string };
        const args = { tabId, captureId: captured.textCaptureId };
        if (change === "navigation")
          NodeVM.runInContext("location.href = 'https://other.test/'", host.context);
        else if (change === "reload") host.listeners.get("pagehide")!();
        else if (change === "expiry") [...host.timers][0]!();
        else if (change === "replacement") {
          const newer = yield* callSnapshot({ captureText: true });
          expect(newer.isError).toBe(false);
          expect(host.timers.size).toBe(1);
        } else yield* callReadText({ ...args, release: true });

        const result = yield* callReadText(args);

        expect(result.isError).toBe(true);
        expect(encodeJsonText(result)).toContain("captureText");
        expect(encodeJsonText(result)).not.toContain("private loaded text");
        if (change !== "replacement") {
          expect(host.timers.size).toBe(0);
          expect(host.listeners.size).toBe(0);
        }
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("does not expose another provider session's text capture", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-isolated-text-read-client", "private loaded text");
      const snapshot = yield* callSnapshot({ captureText: true });
      const captured = snapshot.structuredContent as { readonly textCaptureId: string };
      const args = { tabId, captureId: captured.textCaptureId };

      const foreign = yield* callReadText(args, {
        ...invocation,
        thread: { ...invocation.thread, providerSessionId: "different-session" },
      });

      expect(foreign.isError).toBe(true);
      expect(encodeJsonText(foreign)).not.toContain("private loaded text");
      const own = yield* callReadText(args);
      expect(own.isError).toBe(false);
      expect(own.structuredContent).toMatchObject({ text: "private loaded text" });
      expect(host.timers.size).toBe(1);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { name: "preview_snapshot", args: { captureText: true } },
  { name: "preview_read_text", args: { tabId, captureId: "capture" } },
])("requires a thread caller for $name even with the preview capability", ({ name, args }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* serveTextCaptures("mcp-client-text-capture-denied", "Loaded text");
      const server = yield* McpServer.McpServer;

      const denied = yield* server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          thread: undefined,
          client: {
            sessionId: "outside-thread-session",
            label: "MCP client",
            runtimeModeCeiling: "auto",
          },
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        error: { _tag: "PreviewAutomationUnavailableError" },
      });
      expect(host.requests).toEqual([]);
      expect(host.textReads()).toBe(0);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "registers the pull request toolkit and surfaces a missing capability as a tool error",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "link_pull_request",
          "unlink_pull_request",
          "list_thread_pull_requests",
        ]),
      );
      const linkTool = server.tools.find(({ tool }) => tool.name === "link_pull_request");
      expect(linkTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(linkTool?.tool.annotations?.openWorldHint).toBe(false);
      expect(linkTool?.tool.description).toContain("Register every pull request you open");

      const denied = yield* server
        .callTool({ name: "list_thread_pull_requests", arguments: {} })
        .pipe(
          // A preview-only credential: the token predates the toolkit or was minted elsewhere.
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(PullRequestsTestLayer)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Mirrors the real failure: a [role] container whose innerText is the whole
      // project list, repeated for several elements, plus a big AX tree.
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [identity, text, notice] = snapshot.content;
      expect(identity?.type === "text" ? decodeJsonText(identity.text) : null).toEqual({
        url: oversized.url,
      });
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      // Claude Code shows the model structuredContent instead of the text, so it is bounded too.
      expect(snapshot.structuredContent).toEqual({
        ...parsed,
        omitted: expect.arrayContaining(["60 older console entries"]),
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[2];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds page text made of wide characters before dropping locators", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The character caps alone leave 8,000 three-byte characters, about 24 KB.
      yield* serveSnapshots("mcp-wide-text-client", {
        ...snapshotResult,
        visibleText: "界".repeat(9_000),
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
      });

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<unknown>;
      };
      expect(parsed.visibleText).toMatch(/^界+…$/);
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(notice?.type === "text" ? notice.text : "").toContain(
        "visibleText after 4000 characters",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("sheds log entries before locators when every list is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "x".repeat(2_000);
      const oversized = {
        ...snapshotResult,
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, () => ({
          level: long,
          text: long,
          timestamp: long,
          source: long,
        })),
        networkEntries: Array.from({ length: 200 }, () => ({
          url: long,
          method: long,
          status: 200,
          failed: false,
          errorText: long,
          timestamp: long,
        })),
        actionTimeline: Array.from({ length: 200 }, () => ({
          id: long,
          action: long,
          status: "succeeded",
          startedAt: long,
          completedAt: long,
          error: long,
        })),
      };
      yield* serveSnapshots("mcp-full-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly interactiveElements: ReadonlyArray<unknown>;
        readonly consoleEntries: ReadonlyArray<unknown>;
        readonly networkEntries: ReadonlyArray<unknown>;
        readonly actionTimeline: ReadonlyArray<unknown>;
      };
      // Locators survive; the log lists take the cut.
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(
        parsed.consoleEntries.length + parsed.networkEntries.length + parsed.actionTimeline.length,
      ).toBeLessThan(120);
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("40 of 40 actionTimeline");
      expect(noticeText).not.toMatch(/\d+ of \d+ interactiveElements/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds JSON-escaped page identifiers after other snapshot fields are empty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveSnapshots("mcp-escaped-identifiers-client", {
        ...snapshotResult,
        url: `http://example.test/${"\u0000".repeat(3_000)}`,
        title: "\u0000".repeat(3_000),
        visibleText: "",
      });
      const snapshot = yield* callSnapshot({ includeImage: false });
      expect(snapshot.isError).toBe(false);
      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      expect(notice?.type === "text" ? notice.text : "").toContain(
        "url or title after 1024 characters",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "keeps current-view text and controls when offscreen controls and logs fill the budget",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scroll = {
          x: 0,
          y: 12_000,
          width: 1_000,
          height: 800,
          scrollWidth: 1_000,
          scrollHeight: 20_000,
          containers: [],
          containersTruncated: false,
        };
        yield* serveSnapshots("mcp-current-view-client", {
          ...snapshotResult,
          visibleText: "Page start ".repeat(4_000),
          viewportText: "Bottom of page: choose Continue to finish.",
          scroll,
          truncated: { visibleText: true, viewportText: false, interactiveElements: true },
          interactiveElements: Array.from({ length: 240 }, (_, index) => ({
            tag: "button",
            role: "button",
            name: `Button ${index}`,
            selector: `#button-${index}-${"x".repeat(500)}`,
            inViewport: index >= 237,
            x: 0,
            y: index >= 237 ? 20 : -1_000,
            width: 10,
            height: 10,
          })),
          consoleEntries: Array.from({ length: 100 }, (_, index) => ({
            level: "log",
            text: `Log ${index}: ${"x".repeat(2_000)}`,
            timestamp: "t",
          })),
        });

        const snapshot = yield* callSnapshot({ includeImage: false });
        expect(snapshot.isError).toBe(false);
        const [, text, notice] = snapshot.content;
        const body = text?.type === "text" ? text.text : "";
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
          McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
        );
        const parsed = decodeJsonText(body) as {
          readonly viewportText: string;
          readonly scroll: unknown;
          readonly truncated: unknown;
          readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        };
        expect(parsed.viewportText).toBe("Bottom of page: choose Continue to finish.");
        expect(parsed.scroll).toEqual(scroll);
        expect(parsed.truncated).toEqual({
          visibleText: true,
          viewportText: false,
          interactiveElements: true,
        });
        expect(parsed.interactiveElements.slice(0, 3).map((element) => element.name)).toEqual([
          "Button 237",
          "Button 238",
          "Button 239",
        ]);
        expect(notice?.type === "text" ? notice.text : "").toContain("interactiveElements");
        expect(snapshot.structuredContent).toEqual({ ...parsed, omitted: expect.any(Array) });
        expect(snapshot.content.some((content) => content.type === "image")).toBe(false);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect.each(["界😀".repeat(5_000), `${"a".repeat(7_999)}${"😀".repeat(4_000)}`])(
  "bounds current-view Unicode text without splitting a character %#",
  (viewportText) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveSnapshots("mcp-viewport-unicode-client", {
          ...snapshotResult,
          viewportText,
          visibleText: "Offscreen ".repeat(4_000),
          truncated: { visibleText: false, viewportText: false, interactiveElements: false },
          interactiveElements: Array.from({ length: 20 }, (_, index) => ({
            tag: "button",
            role: "button",
            name: `Button ${index}`,
            selector: `#button-${index}-${"x".repeat(500)}`,
            inViewport: true,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
          })),
        });
        const snapshot = yield* callSnapshot({ includeImage: false });
        expect(snapshot.isError).toBe(false);
        const [, text, notice] = snapshot.content;
        const body = text?.type === "text" ? text.text : "";
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
          McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
        );
        const parsed = decodeJsonText(body) as {
          readonly viewportText: string;
          readonly interactiveElements: ReadonlyArray<unknown>;
        };
        expect(parsed.interactiveElements.length).toBeGreaterThan(0);
        expect(parsed.viewportText.length).toBeGreaterThan(1_000);
        expect(parsed.viewportText.endsWith("…")).toBe(true);
        expect(parsed.viewportText.isWellFormed()).toBe(true);
        expect(parsed).toMatchObject({ truncated: { viewportText: true } });
        expect(notice?.type === "text" ? notice.text : "").toContain("viewportText after");
        expect(snapshot.structuredContent).toEqual({ ...parsed, omitted: expect.any(Array) });
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps current-view Unicode text in full when it fits the snapshot budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const viewportText = "界".repeat(5_000);
      yield* serveSnapshots("mcp-viewport-full-unicode-client", {
        ...snapshotResult,
        visibleText: "",
        viewportText,
      });
      const snapshot = yield* callSnapshot({ includeImage: false });
      expect(snapshot.isError).toBe(false);
      expect(snapshot.structuredContent).toMatchObject({ viewportText });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds scroll-container locators while preserving page scroll position", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveSnapshots("mcp-scroll-budget-client", {
        ...snapshotResult,
        viewportText: "Current content",
        scroll: {
          x: 20,
          y: 8_000,
          width: 1_000,
          height: 800,
          scrollWidth: 2_000,
          scrollHeight: 10_000,
          containers: Array.from({ length: 20 }, () => ({
            selector: `#${"x".repeat(30_000)}`,
            x: 0,
            y: 200,
            width: 100,
            height: 100,
            scrollWidth: 100,
            scrollHeight: 1_000,
          })),
          containersTruncated: false,
        },
      });
      const snapshot = yield* callSnapshot({ includeImage: false });
      expect(snapshot.isError).toBe(false);
      const [, text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      expect(decodeJsonText(body)).toMatchObject({
        viewportText: "Current content",
        scroll: { x: 20, y: 8_000, containers: [], containersTruncated: true },
      });
      expect(notice?.type === "text" ? notice.text : "").toContain("20 of 20 scrollContainers");
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
  ).pipe(
    Effect.provide(
      HttpServer.layerTestClient.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
        ),
      ),
    ),
  ),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const toolIcon = {
        _tag: "website" as const,
        pageUrl: "http://example.test/",
      };
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
              ? snapshotResult
              : event.request.operation === "evaluate"
                ? ["Connect", "Continue"]
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
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(false);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const readTextTool = server.tools.find(({ tool }) => tool.name === "preview_read_text");
      expect(readTextTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(readTextTool?.tool.annotations?.idempotentHint).toBe(false);
      expect(readTextTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(readTextTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(readTextTool?.tool.outputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["text", "nextOffset", "totalChars", "done", "released"]),
      });

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: true,
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

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"], toolIcon });
      const evaluatedText = evaluated.content[0];
      expect(evaluatedText?.type === "text" ? decodeJsonText(evaluatedText.text) : null).toEqual({
        toolIcon,
        value: ["Connect", "Continue"],
      });

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
        expect(result.structuredContent).toEqual({ toolIcon });
        expect(routedRequests.at(-1)?.operation).toBe("status");
        const text = result.content[0];
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual({ toolIcon });
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
