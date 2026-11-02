import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceId,
  DeviceOperationError,
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

import * as DeviceService from "../device/DeviceService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
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

it.effect.each([
  { input: {}, open: false, message: "No device is open in this thread. Call device_open first." },
  {
    input: { deviceId: "missing" },
    open: false,
    message: "Device missing is not open in this thread. Call device_open first.",
  },
  {
    input: {},
    open: true,
    message:
      "Device screenshot failed: Could not communicate with device support. Try refreshing devices.",
  },
  {
    input: {},
    open: true,
    rejected: true,
    message:
      "Device screenshot failed: The device hub could not complete the request. Call device_list to check the device state, and device_open if it needs to be reopened.",
  },
])(
  "preserves actionable screenshot failure text: $message",
  ({ input, open, message, ...options }) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server.callTool({ name: "device_screenshot", arguments: input }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["device"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: message }]);
      expect(result.structuredContent).toMatchObject({
        error: { message, operation: "screenshot" },
      });
      expect(JSON.stringify(result)).not.toContain("private hub output");
    }).pipe(
      Effect.provide(
        McpHttpServer.layerDeviceToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(DeviceService.DeviceService)({
              locateSession: () => Effect.succeedNone,
              sessionsForThread: () =>
                Effect.succeed(
                  open
                    ? [
                        {
                          threadId,
                          hostId: "local",
                          deviceId: DeviceId.make("phone"),
                          platform: "ios",
                          openedAt: "2026-10-23T00:00:00Z",
                        },
                      ]
                    : [],
                ),
              screenshot: () =>
                Effect.fail(
                  new DeviceOperationError({
                    operation: "screenshot",
                    reason:
                      "rejected" in options && options.rejected ? "hub_rejected" : "request_failed",
                    cause: new Error("private hub output"),
                  }),
                ),
            }),
          ),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-mcp-test-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);

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
      .callTool({ name: "preview_act", arguments: { action: "click", locator: "text=Send" } })
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

it.effect("advertises the compact input schema for every registered tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools: Record<string, Tool.Any> = PreviewToolkit.tools;

    expect(server.tools.length).toBe(Object.keys(tools).length);
    for (const { tool } of server.tools) {
      expect(tool.inputSchema, tool.name).toEqual(advertisedJsonSchema(tools[tool.name]!));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("checks each preview_act action against that action's own input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inputs = yield* serveSnapshots("mcp-act-client", {});

      const missingKey = yield* callTool("preview_act", { action: "press" });
      expect(missingKey.isError).toBe(true);
      expect(inputs).toEqual([]);

      const click = yield* callTool("preview_act", {
        action: "click",
        locator: "text=Send",
        key: "Enter",
      });
      expect(click.isError).toBe(false);
      expect(inputs[0]).toEqual({ locator: "text=Send" });

      yield* callTool("preview_act", { action: "type", selector: "#name", text: "Ada" });
      expect(inputs.at(-2)).toEqual({ selector: "#name", text: "Ada" });
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("decodes null optional arguments the way it decodes omitted ones", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const thread = { threadId: "thread-null-arguments" };
    yield* callTool("t3_thread_read", thread);
    yield* callTool("t3_thread_read", { ...thread, afterPosition: null, view: null });
    yield* callTool("delegate_task", { task: "Inspect", target: {} });
    yield* callTool("delegate_task", { task: "Inspect", title: null, target: { model: null } });
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

it("keeps cross-tool routing out of the delegate_task description", () => {
  const description = OrchestratorToolkit.tools.delegate_task.description ?? "";
  expect(description).toContain("Start one child agent with only `task`");
  // Review rounds, follow-ups, and polling are routed in the system text.
  expect(description).not.toContain("t3_thread_send");
  expect(description).not.toContain("Do not poll");
  expect(description).not.toContain("Prefer native");
});

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
      expect(linkTool?.tool.description).toContain("Link a PR to this thread");
      expect(linkTool?.tool.description).toContain("settles the thread on merge");

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
        Layer.provide(ServerSettings.layerTest()),
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
        Layer.provideMerge(
          McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
        ),
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

it.effect("accepts case-insensitive MCP bearer schemes and diagnoses rejected credentials", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-auth-header-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
      const oauth = yield* auth.issueMcpClientSession({
        label: "MCP header test",
        access: "read-only",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport.pipe(
          Layer.provide(McpOAuth.layerMcpClientAuthenticator),
          Layer.provide(ServerSettings.layerTest()),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initialize = (authorization?: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-header-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });

      for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
        for (const [kind, token] of [
          ["provider", providerToken],
          ["OAuth", oauth.token],
        ]) {
          const response = yield* initialize(`${scheme} ${token}`);
          expect.soft(response.status, `${kind} ${scheme}`).toBe(200);
        }
      }
      messages.length = 0;
      for (const [authorization, reason] of [
        [undefined, "missing_authorization_header"],
        [`Basic ${providerToken}`, "unsupported_scheme"],
        ["Bearer", "missing_bearer_token"],
        ["bEaReR ", "missing_bearer_token"],
        [`bearer ${providerToken.toUpperCase()}`, "unknown_or_expired_token"],
        [`bEaReR ${oauth.token.toUpperCase()}`, "unknown_or_expired_token"],
      ] as const) {
        const response = yield* initialize(authorization);
        expect(response.status).toBe(401);
        expect
          .soft(messages.at(-1))
          .toEqual(["rejected MCP request with an unusable credential", { reason }]);
        const body = yield* response.text;
        expect(body).not.toContain(providerToken);
        expect(body).not.toContain(oauth.token);
        expect(JSON.stringify(response.headers)).not.toContain(providerToken);
        expect(JSON.stringify(response.headers)).not.toContain(oauth.token);
      }
      yield* registry.revokeThread(threadId);
      yield* auth.revokeSession(oauth.sessionId);
      for (const token of [providerToken, oauth.token]) {
        expect((yield* initialize(`bearer ${token}`)).status).toBe(401);
      }
      expect(JSON.stringify(messages)).not.toContain(providerToken);
      expect(JSON.stringify(messages)).not.toContain(oauth.token);
      expect(JSON.stringify(messages)).not.toContain(providerToken.toUpperCase());
      expect(JSON.stringify(messages)).not.toContain(oauth.token.toUpperCase());
    }),
  ).pipe(
    Effect.provide(
      layerAuth.pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ),
  );
});

it.effect("hides tools for links and refuses another environment while the beta is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "linksToken";
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make("thread-links"),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const LinksToolkit = Toolkit.make(
        Tool.make("links", {
          description: "Lists links.",
          success: Schema.Struct({ links: Schema.Number }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileLinksOff),
        Tool.make("where", {
          description: "Says where it ran.",
          parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
          success: Schema.Struct({ ranIn: Schema.String }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
      );
      const settingsContext = yield* Layer.build(ServerSettings.layerTest());
      const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
      const serverLayer = McpHttpServer.toolkitRegistration(
        LinksToolkit,
        McpToolAccess.toLayer(LinksToolkit, {
          links: McpToolAccess.reads(() => Effect.succeed({ links: 0 })),
          where: McpToolAccess.reads(() => Effect.succeed({ ranIn: "here" })),
        }),
      ).pipe(
        Layer.provideMerge(
          McpHttpServer.layerMcpTransport.pipe(
            Layer.provide(Layer.succeedContext(settingsContext)),
          ),
        ),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const rpc = (method: string, params: object) =>
        httpClient
          .post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((response) => response.json));
      const listed = () =>
        rpc("tools/list", {}).pipe(
          Effect.map((body) =>
            (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
              (tool) => tool.name,
            ),
          ),
        );
      const ranIn = (where: EnvironmentId) =>
        rpc("tools/call", { name: "where", arguments: { environmentId: where } }).pipe(
          Effect.map(
            (body) =>
              (
                body as {
                  result: {
                    isError?: boolean;
                    structuredContent?: unknown;
                    content: ReadonlyArray<{ text: string }>;
                  };
                }
              ).result,
          ),
        );
      const elsewhere = EnvironmentId.make("environment-elsewhere");

      expect(yield* listed()).toEqual(["where"]);
      expect(yield* ranIn(elsewhere)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("Linked environments is off on this machine") }],
      });
      expect((yield* ranIn(environmentId)).structuredContent).toEqual({ ranIn: "here" });

      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      expect(yield* listed()).toEqual(["links", "where"]);
      // On, the call goes on to the forwarding, which this server lacks.
      expect(yield* ranIn(elsewhere)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("cannot reach linked environments") }],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists pull request watch tools only to threads that are not delegated children", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeFor = (
        token: string,
        subagent: boolean,
      ): McpInvocationContext.McpThreadInvocationScope => ({
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make(`thread-${token}`),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
          subagent,
        },
        client: undefined,
        capabilities: new Set(["pull-requests"]),
        issuedAt: 1,
      });
      const scopes = new Map([
        ["parentToken", scopeFor("parentToken", false)],
        ["childToken", scopeFor("childToken", true)],
      ]);
      const serverLayer = McpHttpServer.layerPullRequestsToolkit.pipe(
        Layer.provideMerge(
          McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
        ),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(scopes.get(token)),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            McpToolAccessTestkit.liveThreadsLayer,
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            NodeServices.layer,
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const listedTools = (token: string) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const listed = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const body = (yield* listed.json) as {
            readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
          };
          return body.result.tools.map((tool) => tool.name);
        });

      const parentTools = yield* listedTools("parentToken");
      const childTools = yield* listedTools("childToken");
      expect(parentTools).toEqual(
        expect.arrayContaining(["link_pull_request", "watch_pull_request", "unwatch_pull_request"]),
      );
      expect(childTools).toContain("link_pull_request");
      expect(childTools).not.toContain("watch_pull_request");
      expect(childTools).not.toContain("unwatch_pull_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "narrows an OAuth client's modes to the T3-Mode-Limit it sends, and never widens them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientToken = "client-payload.client-signature";
        const clientScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:linked",
          thread: undefined,
          client: { sessionId: "linked", label: "T3 Code · laptop", access: "auto" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        // Starts a thread at the modes the gate hands it, so the outcome is those modes.
        const StartsToolkit = Toolkit.make(
          Tool.make("starts", {
            description: "Reports the modes a started thread would run with.",
            parameters: Schema.Struct({
              runtimeMode: Schema.optional(RuntimeMode),
              interactionMode: Schema.optional(ProviderInteractionMode),
            }),
            success: Schema.Struct({ modes: Schema.String }),
            failure: OrchestratorMcpFailure,
            failureMode: "return",
            dependencies: [
              McpInvocationContext.McpInvocationContext,
              ThreadManagementService.ThreadManagementService,
            ],
          }),
        );
        const serverLayer = McpHttpServer.toolkitRegistration(
          StartsToolkit,
          McpToolAccess.toLayer(StartsToolkit, {
            starts: McpToolAccess.startsThreads(
              (input) => input,
              (_, modes) =>
                Effect.succeed({ modes: `${modes.runtimeMode}/${modes.interactionMode}` }),
              "stamped",
            ),
          }),
        ).pipe(
          Layer.provideMerge(
            McpHttpServer.layerMcpTransport.pipe(Layer.provide(ServerSettings.layerTest())),
          ),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
              resolve: () => Effect.succeed(undefined),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === `Bearer ${clientToken}`
                    ? clientScope
                    : undefined,
                ),
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const decodeOutcome = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              result: Schema.Struct({
                content: Schema.Array(Schema.Struct({ text: Schema.String })),
              }),
            }),
          ),
        );
        const decodeText = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Union([
              Schema.Struct({ modes: Schema.String }),
              Schema.Struct({ code: Schema.String }),
            ]),
          ),
        );
        /** Starts a thread as the client, with `limit` as T3-Mode-Limit; the HTTP status or the outcome. */
        const start = (limit: string | undefined, args: Record<string, string> = {}) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${clientToken}`,
              ...(limit === undefined ? {} : { "t3-mode-limit": limit }),
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            if (initialize.status !== 200) return initialize.status;
            const response = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "starts", arguments: args },
                }),
                "application/json",
              ),
            });
            const body = yield* decodeOutcome(yield* response.text);
            const outcome = yield* decodeText(
              body.result.content.map((part) => part.text).join(""),
            );
            return "code" in outcome ? outcome.code : outcome.modes;
          });

        // Approved for auto: without the header the client keeps its ceiling.
        expect(yield* start(undefined)).toBe("auto/default");
        // The header narrows both modes, and asking above it is refused.
        expect(yield* start("approval-required/plan")).toBe("approval-required/plan");
        expect(yield* start("approval-required/plan", { runtimeMode: "auto" })).toBe(
          "runtime_mode_escalation_denied",
        );
        expect(yield* start("auto-accept-edits/plan", { interactionMode: "default" })).toBe(
          "interaction_mode_escalation_denied",
        );
        // A broader header changes nothing: the approved ceiling still holds.
        expect(yield* start("full-access/default")).toBe("auto/default");
        expect(yield* start("full-access/default", { runtimeMode: "full-access" })).toBe(
          "runtime_mode_escalation_denied",
        );
        // A malformed header is refused before anything runs.
        expect(yield* start("auto")).toBe(400);
        expect(yield* start("auto/default/extra")).toBe(400);
        expect(yield* start("root/default")).toBe(400);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
