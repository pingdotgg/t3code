import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
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
const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerPullRequestsTest = McpHttpServer.layerPullRequestsToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
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

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const callSnapshot = (args: Record<string, unknown>) => callTool("preview_snapshot", args);

// Real tool definitions with handlers that record what they decoded.
const layerRecordingTools = (calls: Array<unknown>) => {
  const RecordingToolkit = Toolkit.make(
    OrchestratorToolkit.tools.delegate_task,
    OrchestratorToolkit.tools.t3_thread_read,
    OrchestratorToolkit.tools.t3_thread_wait,
    ProjectToolkit.tools.t3_project_update,
  );
  const record = McpToolAccess.reads((params: unknown) =>
    Effect.sync(() => calls.push(params)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." })),
      ),
    ),
  );
  return McpHttpServer.toolkitRegistration(
    RecordingToolkit,
    McpToolAccess.toLayer(RecordingToolkit, {
      delegate_task: record,
      t3_thread_read: record,
      t3_thread_wait: record,
      t3_project_update: record,
    }),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        NodeServices.layer,
      ),
    ),
  );
};

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
    ).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { mode: "default", input: {}, images: false },
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

      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text", "text", "text"]);
      expect(nextDefault.structuredContent).toMatchObject({ title: "Snapshot 7", screenshot });
      expect(nextDefault.structuredContent).not.toHaveProperty("accessibilityTree");
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("refuses preview tools to a client outside a thread before they run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readOnly = {
      ...invocation,
      thread: undefined,
      requestNamespace: "client:session-1",
      client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    };
    const click = yield* server
      .callTool({ name: "preview_click", arguments: { locator: "text=Send" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, readOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(click.isError).toBe(true);
    expect(click.content).toEqual([
      { type: "text", text: expect.stringContaining("needs an agent running inside T3 Code") },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("decodes null optional arguments the way it decodes omitted ones", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const thread = { threadId: "thread-null-arguments" };
    yield* callTool("t3_thread_read", thread);
    yield* callTool("t3_thread_read", { ...thread, afterPosition: null, view: null });
    yield* callTool("delegate_task", { task: "Inspect", target: {} });
    yield* callTool("delegate_task", { task: "Inspect", title: null, target: { model: null } });
    // A null the schema declares keeps its meaning: here it clears the project icon.
    yield* callTool("t3_project_update", { projectId: "project-1", projectIcon: null });

    expect(calls).toHaveLength(5);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[3]).toEqual(calls[2]);
    expect(calls[4]).toStrictEqual({ projectId: "project-1", projectIcon: null });
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect(
  "clamps t3_thread_read page sizes above their maximum instead of rejecting the call",
  () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      const thread = { threadId: "thread-clamped-arguments" };
      // Codex never shows the model these bounds, so an over-large page must still read.
      yield* callTool("t3_thread_read", {
        ...thread,
        limit: 150,
        runLimit: 80,
        maxCharsPerItem: 60_000,
      });
      yield* callTool("t3_thread_read", {
        ...thread,
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 50_000,
      });
      yield* callTool("t3_thread_read", { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 });

      expect(calls).toEqual([
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 50_000 },
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 50_000 },
        { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 },
      ]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
);

it.effect.each(["limit", "runLimit", "maxCharsPerItem"])(
  "still rejects a t3_thread_read %s below its minimum",
  (field) => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      // Zero is a different request than one item, so it fails rather than answering another question.
      const rejected = yield* callTool("t3_thread_read", {
        threadId: "thread-below-minimum",
        [field]: 0,
      }).pipe(Effect.flip);

      expect(String(rejected)).toContain("greater than or equal to 1");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
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
      expect(linkTool?.tool.description).toContain("Register every pull request you create");
      expect(linkTool?.tool.description).toContain(
        "Do not link pull requests you only read or review.",
      );

      const denied = yield* server
        .callTool({ name: "list_thread_pull_requests", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(layerPullRequestsTest)),
);

it.effect("bounds large ARIA trees without dropping every server locator", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const accessibilityTree = Array.from(
        { length: 2_000 },
        (_, index) => `- button "删除 ${index}" [ref=t3-snapshot-e${index}]`,
      ).join("\n");
      yield* serveSnapshots("mcp-large-server-refs", { ...snapshotResult, accessibilityTree });
      const result = yield* callSnapshot({ includeImage: false });
      expect(result.isError).toBe(false);
      const metadata = result.structuredContent as { accessibilityTree: string };
      expect(metadata.accessibilityTree).toContain("[ref=t3-snapshot-e0]");
      expect(metadata.accessibilityTree.length).toBeLessThan(accessibilityTree.length);
      const body = result.content[1];
      expect(Buffer.byteLength(body?.type === "text" ? body.text : "", "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
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
  ).pipe(Effect.provide(layerTest)),
);

// regression: #10501 keep preview snapshots usable by the agent
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
  ).pipe(Effect.provide(layerTest)),
);

// regression: #13558 preview snapshots overflowed the agent's tool output
it.effect("bounds page text made of wide characters before dropping locators", () =>
  Effect.scoped(
    Effect.gen(function* () {
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
  ).pipe(Effect.provide(layerTest)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport.pipe(
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

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

it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
              Effect.as({ ok: true }),
            ),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
