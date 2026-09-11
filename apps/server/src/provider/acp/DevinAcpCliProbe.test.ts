/**
 * Optional integration checks against a real `devin` CLI installation.
 * Enable with: T3_DEVIN_ACP_PROBE=1 vp test run DevinAcpCliProbe
 * Set T3_DEVIN_BINARY_PATH when `devin` is not on PATH.
 *
 * Set T3_DEVIN_LIVE_TURN=1 to send a real prompt. This consumes Devin usage.
 * Set T3_DEVIN_MCP_SMOKE=1 to drive a real turn through the local T3 MCP server.
 * T3_DEVIN_TEST_MODEL selects the model used by the MCP and resume checks.
 * The regular Devin adapter tests use the local ACP fixture for permissions,
 * cancellation, image input, and failure recovery; these checks validate the
 * installed CLI's command and ACP compatibility at the opt-in boundary.
 */
// @effect-diagnostics nodeBuiltinImport:off - the opt-in smoke test creates and removes an isolated real workspace.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Schema from "effect/Schema";
import {
  DevinSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { DeviceService } from "../../device/DeviceService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { checkDevinProviderStatus } from "../Layers/DevinProvider.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { makeDevinAcpRuntime } from "./DevinAcpSupport.ts";
import {
  DEVIN_OPTIONAL_CONTENT_UNSUPPORTED_FIXTURE,
  createDevinAcpCapture,
  selectDevinOptionalContent,
  type DevinAcpCapture,
} from "./DevinOptionalContentFixtures.test.ts";

const configuredBinary = process.env.T3_DEVIN_BINARY_PATH?.trim() || "devin";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeProbeSettings = () =>
  decodeDevinSettings({
    enabled: true,
    binaryPath: configuredBinary,
    customModels: [],
  });

const runDevinCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(configuredBinary, args, { env: process.env });
    return yield* spawnAndCollect(
      configuredBinary,
      ChildProcess.make(spawn.command, spawn.args, {
        env: process.env,
        shell: spawn.shell,
      }),
    );
  });

const makeProbeRuntime = (capture?: DevinAcpCapture) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeDevinAcpRuntime({
      devinSettings: { binaryPath: configuredBinary },
      environment: process.env,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-devin-probe", version: "0.0.0" },
      ...(capture
        ? {
            protocolLogging: {
              logIncoming: true,
              logger: (event: unknown) => Effect.sync(() => capture.write(event)),
            },
          }
        : {}),
    });
  });

const captureEnabled = process.env.T3_DEVIN_ACP_CAPTURE === "1";

const emitCapture = (capture: DevinAcpCapture | undefined, force = false) =>
  Effect.sync(() => {
    if (!capture || (!captureEnabled && !force)) return;
    const records = selectDevinOptionalContent(capture.records());
    process.stderr.write(
      `${encodeUnknownJson({
        optionalContent: records.length > 0 ? records : DEVIN_OPTIONAL_CONTENT_UNSUPPORTED_FIXTURE,
      })}\n`,
    );
  });

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("reports the real CLI auth state without invoking login", () =>
    runDevinCommand(["auth", "status"]).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const output = `${result.stdout}\n${result.stderr}`;
          expect(result.code).toBe(0);
          expect(output).toMatch(/logged in|authenticated/iu);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("discovers the current model catalog through the provider health check", () =>
    checkDevinProviderStatus(makeProbeSettings(), process.env).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth.status).toBe("authenticated");
          expect(snapshot.models.length).toBeGreaterThan(0);
          expect(snapshot.models.some((model) => model.slug === "adaptive")).toBe(true);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("starts a real ACP session and accepts an advertised model selection", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");
      expect(started.initializeResult).toBeDefined();
      expect(started.sessionSetupResult).toBeDefined();

      const configOptions = yield* runtime.getConfigOptions;
      const modelConfig = configOptions.find(
        (option) => option.category === "model" || option.id === started.modelConfigId,
      );
      expect(modelConfig).toBeDefined();
      expect(modelConfig?.type).toBe("select");
      if (modelConfig?.type !== "select") return;

      const values = modelConfig.options.flatMap((option) =>
        "value" in option ? [option.value] : option.options.map((nested) => nested.value),
      );
      expect(values.length).toBeGreaterThan(0);
      const target = values.find((value) => value !== modelConfig.currentValue);
      yield* runtime.setModel(target ?? modelConfig.currentValue);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_DEVIN_LIVE_TURN !== "1")(
    "finishes a real Devin turn and streams its answer",
    () => {
      const capture = createDevinAcpCapture(captureEnabled);
      return Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime(capture);
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") {
            chunks.push(event.text);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply exactly T3_DEVIN_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("T3_DEVIN_OK");
        yield* Fiber.interrupt(events);
        yield* emitCapture(capture);
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.tapError(() => emitCapture(capture, true)),
      );
    },
  );
});

const DevinMcpSmokeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-devin-mcp-smoke-",
}).pipe(
  Layer.provideMerge(
    HttpServer.layerTestClient.pipe(
      Layer.provide(
        Layer.fresh(FetchHttpClient.layer).pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
        ),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
    ),
  ),
);

describe.runIf(process.env.T3_DEVIN_MCP_SMOKE === "1")("Devin MCP smoke", () => {
  it.effect(
    "runs a real Devin ACP turn through the T3 MCP server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make("devin-mcp-smoke-environment");
          const threadId = ThreadId.make("devin-mcp-smoke-thread");
          const providerInstanceId = ProviderInstanceId.make("devin");
          const workspace = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-devin-mcp-workspace-")),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => NodeFSP.rm(workspace, { recursive: true, force: true })),
          );

          const serverEnvironmentLayer = Layer.succeed(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(environmentId),
              getDescriptor: Effect.die("Devin MCP smoke does not read the environment descriptor"),
            }),
          );
          const mcpContext = yield* Layer.build(
            Layer.mergeAll(
              McpSessionRegistry.layer.pipe(Layer.provideMerge(serverEnvironmentLayer)),
              PreviewAutomationBroker.layer,
            ),
          );
          yield* HttpRouter.serve(
            McpHttpServer.layer.pipe(
              Layer.provide(Layer.succeedContext(mcpContext)),
              Layer.provide(Layer.mock(DeviceService)({})),
              Layer.provide(Layer.mock(OrchestrationEngineService)({})),
              Layer.provide(Layer.mock(ProjectionSnapshotQuery)({})),
            ),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.build);

          const registry = Context.get(mcpContext, McpSessionRegistry.McpSessionRegistry);
          const broker = Context.get(mcpContext, PreviewAutomationBroker.PreviewAutomationBroker);
          const issued = yield* registry.issue({
            threadId,
            providerInstanceId,
            capabilities: new Set(["preview"]),
          });
          const issuedToken = issued.config.authorizationHeader.slice("Bearer ".length);
          yield* Effect.addFinalizer(() =>
            registry.revokeProviderSession(issued.config.providerSessionId).pipe(
              Effect.andThen(registry.resolve(issuedToken)),
              Effect.tap((scope) =>
                Effect.sync(() => {
                  expect(scope).toBeUndefined();
                }),
              ),
              Effect.asVoid,
            ),
          );
          McpProviderSession.setMcpProviderSession(issued.config);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
          );

          const httpClient = yield* HttpClient.HttpClient;
          const postMcp = (body: Readonly<Record<string, unknown>>, mcpSessionId?: string) =>
            httpClient.post("/mcp", {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: issued.config.authorizationHeader,
                "content-type": "application/json",
                ...(mcpSessionId === undefined
                  ? {}
                  : {
                      "mcp-session-id": mcpSessionId,
                      "mcp-protocol-version": "2025-06-18",
                    }),
              },
              body: HttpBody.text(encodeUnknownJson(body), "application/json"),
            });

          const initializeResponse = yield* postMcp({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t3-devin-mcp-smoke", version: "0.0.0" },
            },
          });
          const mcpSessionId = initializeResponse.headers["mcp-session-id"];
          expect(initializeResponse.status).toBe(200);
          expect(mcpSessionId).toBeTruthy();
          if (!mcpSessionId) return;
          yield* Effect.addFinalizer(() =>
            httpClient
              .del("/mcp", {
                headers: {
                  authorization: issued.config.authorizationHeader,
                  "mcp-session-id": mcpSessionId,
                  "mcp-protocol-version": "2025-06-18",
                },
              })
              .pipe(Effect.ignore),
          );

          yield* postMcp(
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            mcpSessionId,
          );
          const toolsResponse = yield* postMcp(
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            mcpSessionId,
          );
          expect(toolsResponse.status).toBe(200);
          const toolsBody = (yield* toolsResponse.json) as {
            readonly result?: { readonly tools?: ReadonlyArray<{ readonly name?: string }> };
          };
          expect(toolsBody.result?.tools?.some((tool) => tool.name === "preview_status")).toBe(
            true,
          );

          const requests: Array<{ readonly threadId: ThreadId; readonly operation: string }> = [];
          const hostEvents = yield* broker.connect({
            clientId: "devin-mcp-smoke-preview-host",
            environmentId,
            supportedOperations: ["status"],
          });
          yield* Stream.runForEach(hostEvents, (event) => {
            if (event.type === "connected") return Effect.void;
            requests.push({ threadId: event.request.threadId, operation: event.request.operation });
            return broker.respond({
              clientId: "devin-mcp-smoke-preview-host",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                available: true,
                visible: false,
                tabId: null,
                url: null,
                title: null,
                loading: false,
              },
            });
          }).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const adapter = yield* makeDevinAdapter(makeProbeSettings(), {
            environment: process.env,
            promptTimeout: Duration.seconds(180),
          });
          yield* Effect.addFinalizer(() => adapter.stopSession(threadId).pipe(Effect.ignore));
          const runtimeEvents: ProviderRuntimeEvent[] = [];
          let turnCompleted = yield* Deferred.make<void>();
          yield* Stream.runForEach(adapter.streamEvents, (event) => {
            if (event.threadId !== threadId) return Effect.void;
            runtimeEvents.push(event);
            return event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const session = yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devin"),
            cwd: workspace,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: providerInstanceId,
              model: process.env.T3_DEVIN_TEST_MODEL ?? "adaptive",
            },
          });
          yield* adapter.sendTurn({
            threadId,
            input:
              "Call the MCP tool preview_status on t3-code exactly once. After the tool succeeds, reply exactly T3_DEVIN_MCP_OK and do not use any other tool.",
          });
          yield* Deferred.await(turnCompleted);

          const assistantText = runtimeEvents
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join("");
          expect(requests, `Devin reply: ${assistantText}`).toHaveLength(1);
          expect(assistantText).toContain("T3_DEVIN_MCP_OK");
          expect(
            requests.some(
              (request) => request.threadId === threadId && request.operation === "status",
            ),
          ).toBe(true);
          expect(
            requests.every(
              (request) => request.threadId === threadId && request.operation === "status",
            ),
          ).toBe(true);

          yield* adapter.stopSession(threadId);
          yield* registry.revokeProviderSession(issued.config.providerSessionId);
          expect(yield* registry.resolve(issuedToken)).toBeUndefined();
          const renewed = yield* registry.issue({
            threadId,
            providerInstanceId,
            capabilities: new Set(["preview"]),
          });
          yield* Effect.addFinalizer(() =>
            registry.revokeProviderSession(renewed.config.providerSessionId),
          );
          McpProviderSession.setMcpProviderSession(renewed.config);
          turnCompleted = yield* Deferred.make<void>();
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(workspace, "input.txt"), "T3_WORKSPACE_OK"),
          );
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devin"),
            cwd: workspace,
            runtimeMode: "full-access",
            resumeCursor: session.resumeCursor,
            modelSelection: {
              instanceId: providerInstanceId,
              model: process.env.T3_DEVIN_TEST_MODEL ?? "adaptive",
            },
          });
          yield* adapter.sendTurn({
            threadId,
            input:
              "Read input.txt in the project and write its text into output.txt. Call preview_status on t3-code once again using the live MCP tool, even though you called it earlier. Then reply T3_DEVIN_RESUMED_OK.",
          });
          yield* Deferred.await(turnCompleted);
          expect(requests).toHaveLength(2);
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(workspace, "output.txt"), "utf8"),
            )).trimEnd(),
          ).toBe("T3_WORKSPACE_OK");
        }),
      ).pipe(Effect.provide(DevinMcpSmokeLayer)),
    { timeout: 190_000 },
  );
});
