// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  AcpRegistrySettings,
  ApprovalRequestId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { AcpRegistryRuntimeCoordinator } from "../acp/AcpRegistryRuntimeCoordinator.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "../acp/AcpSessionConfig.ts";
import { makeAcpRegistryAdapter } from "./AcpRegistryAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const instanceId = ProviderInstanceId.make("acp-registry-test");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-acp-registry-adapter-test-" }),
  AcpRegistryRuntimeCoordinator.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

interface JsonRpcLine {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
}

const readRequestLog = (filePath: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JsonRpcLine),
  );

type AcpMockWire = "v1" | "v2";

/** A registry agent whose catalog entry resolves to the ACP mock agent. */
const makeHarness = Effect.fn("makeAcpRegistryAdapterHarness")(function* (input: {
  readonly wire: AcpMockWire;
  readonly agentId?: string;
  readonly env?: Record<string, string>;
}) {
  const directory = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-adapter-")),
  );
  const requestLogPath = NodePath.join(directory, "requests.ndjson");
  const catalog = AcpRegistryCatalog.of({
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.die("unused inspect"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
    resolve: (_settings, cwd, environment) =>
      Effect.succeed({
        agent: {
          id: input.agentId ?? "mock-agent",
          name: "Mock Agent",
          version: "1.0.0",
          description: "ACP registry adapter test agent",
          distribution: { npx: { package: "mock-agent@1.0.0" } },
        },
        distribution: "npx",
        spawn: {
          command: process.execPath,
          args: [mockAgentPath],
          cwd,
          env: {
            ...environment,
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_WIRE: input.wire,
            ...input.env,
          },
        },
      }),
  });
  const adapter = yield* makeAcpRegistryAdapter({
    instanceId,
    settings: decodeSettings({ agentId: input.agentId ?? "mock-agent" }),
    environment: process.env,
  }).pipe(Effect.provideService(AcpRegistryCatalog, catalog));
  const events: Array<ProviderRuntimeEvent> = [];
  // The first approval or question the agent asks the user.
  const interaction = yield* Deferred.make<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => events.push(event)).pipe(
      Effect.andThen(
        event.type === "request.opened" || event.type === "user-input.requested"
          ? Deferred.succeed(interaction, event)
          : Effect.void,
      ),
    ),
  ).pipe(Effect.forkScoped);
  return { adapter, events, interaction, requestLogPath };
});

const acpRegistryAdapterLive = it.layer(testLayer);

// Most registry agents still speak the ACP v1 message shape; v2 covers the upgrade path.
for (const wire of ["v1", "v2"] as const) {
  acpRegistryAdapterLive(`AcpRegistryAdapter (ACP ${wire})`, (it) =>
    acpRegistryAdapterTests(it, wire),
  );
}

function acpRegistryAdapterTests(
  it: Parameters<Parameters<typeof acpRegistryAdapterLive>[1]>[0],
  wire: AcpMockWire,
) {
  it.effect("runs a turn on the agent the registry resolves and applies the stored picks", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-turn");
      const { adapter, events, requestLogPath } = yield* makeHarness({
        wire,
        env: { T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "0" },
      });
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId,
          model: "composer-2",
          options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: "code" }],
        },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "Say hello" });
      yield* adapter.stopSession(threadId);

      assert.equal(session.provider, "acpRegistry");
      assert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "mock-session-1" });
      const turnEvents = events.filter((event) => event.turnId === turn.turnId);
      expect(turnEvents.map((event) => event.type)).toContain("turn.started");
      expect(
        turnEvents.flatMap((event) =>
          event.type === "content.delta" ? [event.payload.delta] : [],
        ),
      ).toContain("hello from mock");
      expect(turnEvents.at(-1)).toMatchObject({
        type: "turn.completed",
        payload: { state: "completed", stopReason: "end_turn" },
      });

      // The stored model and mode picks reach the agent before the prompt.
      const requests = yield* readRequestLog(requestLogPath);
      const configured = requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => [request.params?.configId, request.params?.value]);
      expect(configured).toEqual(
        expect.arrayContaining([
          ["model", "composer-2"],
          ["mode", "code"],
        ]),
      );
      expect(requests.find((request) => request.method === "initialize")?.params).toMatchObject({
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });

      // The provider snapshot follows the live session through the coordinator.
      const configuration = yield* coordinator.getLiveConfiguration(instanceId);
      assert.equal(Option.getOrThrow(configuration).currentModelId, "composer-2");
      const commands = yield* coordinator.getAvailableCommands(instanceId);
      expect(Option.getOrThrow(commands).slashCommands.map((command) => command.name)).toEqual([
        "review",
      ]);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect(
    "asks before a command in approval-required mode and answers with the offered option",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-registry-approval");
        const { adapter, interaction, requestLogPath } = yield* makeHarness({
          wire,
          env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
        });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const turn = yield* adapter
          .sendTurn({ threadId, input: "Read package.json" })
          .pipe(Effect.forkScoped);
        const opened = yield* Deferred.await(interaction);
        if (opened.type !== "request.opened" || opened.requestId === undefined) {
          return assert.fail(`Expected a permission request, got ${opened.type}`);
        }
        expect(opened.payload.options?.map((option) => option.decision)).toEqual([
          "accept",
          "acceptForSession",
          "decline",
          "cancel",
        ]);
        const requestId = ApprovalRequestId.make(opened.requestId);
        yield* adapter.respondToRequest(threadId, requestId, "accept");
        yield* Fiber.join(turn);
        // A second answer is stale. The reactor closes the approval only
        // when the error names it as an unknown pending request.
        const stale = yield* Effect.flip(adapter.respondToRequest(threadId, requestId, "accept"));
        expect(stale.message).toMatch(/unknown pending approval request/i);
        yield* adapter.stopSession(threadId);

        const requests = yield* readRequestLog(requestLogPath);
        expect(requests.map((request) => request.result)).toContainEqual({
          outcome: { outcome: "selected", optionId: "allow-once" },
        });
      }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("asks before an MCP tool call in approval-required mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-mcp-approval");
      const { adapter, events, interaction, requestLogPath } = yield* makeHarness({
        wire,
        env: { T3_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION: "1" },
      });
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Use an MCP tool" })
        .pipe(Effect.forkScoped);
      const opened = yield* Deferred.await(interaction);
      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        return assert.fail(`Expected an approval, got ${opened.type}`);
      }
      expect(opened.payload).toMatchObject({
        requestType: "mcp_elicitation_approval",
        detail: "Approve this request?",
      });
      expect(opened.payload.options?.map((option) => option.decision)).toEqual([
        "accept",
        "decline",
        "cancel",
      ]);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(opened.requestId),
        "decline",
      );
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "request.resolved",
          requestId: opened.requestId,
          payload: { requestType: "mcp_elicitation_approval", decision: "decline" },
        }),
      );
      const requests = yield* readRequestLog(requestLogPath);
      expect(requests.map((request) => request.result)).toContainEqual({ action: "decline" });
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("closes a question the user can no longer answer", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-question-cancel");
      const { adapter, events, interaction } = yield* makeHarness({
        wire,
        env: { T3_ACP_EMIT_ELICITATION: "1" },
      });
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Ask me first" })
        .pipe(Effect.forkScoped);
      const requested = yield* Deferred.await(interaction);
      if (requested.type !== "user-input.requested" || requested.requestId === undefined) {
        return assert.fail(`Expected a question, got ${requested.type}`);
      }
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turn);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "user-input.resolved",
          requestId: requested.requestId,
          payload: { answers: {} },
        }),
      );
      const stale = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId), {
          approved: "true",
        }),
      );
      expect(stale.message).toMatch(/unknown pending user-input request/i);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("turns a form elicitation into questions and answers with typed values", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-elicitation");
      const { adapter, interaction, requestLogPath } = yield* makeHarness({
        wire,
        env: { T3_ACP_EMIT_ELICITATION: "1" },
      });
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Ask me first" })
        .pipe(Effect.forkScoped);
      const requested = yield* Deferred.await(interaction);
      if (requested.type !== "user-input.requested" || requested.requestId === undefined) {
        return assert.fail(`Expected a question, got ${requested.type}`);
      }
      expect(requested.payload.questions).toMatchObject([
        { id: "approved", header: "Approved", options: [{ label: "true" }, { label: "false" }] },
      ]);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId), {
        approved: "true",
      });
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);

      const requests = yield* readRequestLog(requestLogPath);
      expect(requests.map((request) => request.result)).toContainEqual({
        action: "accept",
        content: { approved: true },
      });
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("cancels a pending URL sign-in when the turn is interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-url-cancel");
      const { adapter } = yield* makeHarness({
        wire,
        env: { T3_ACP_EMIT_URL_ELICITATION: "1" },
      });
      const coordinator = yield* AcpRegistryRuntimeCoordinator;
      const opened = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      yield* coordinator
        .watchUrlAuthAction(instanceId, (action) =>
          Deferred.succeed(action === null ? closed : opened, undefined),
        )
        .pipe(Effect.forkScoped);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "Sign in first" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(opened);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turn);
      // The session is still open, so only the cancel can clear the sign-in.
      yield* Deferred.await(closed);
      assert.isTrue(Option.isNone(yield* coordinator.getUrlAuthAction(instanceId)));
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("approves by policy in full access without asking", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-full-access");
      const { adapter, events, requestLogPath } = yield* makeHarness({
        wire,
        env: { T3_ACP_EMIT_TOOL_CALLS: "1" },
      });
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Read package.json" });
      yield* adapter.stopSession(threadId);

      expect(events.map((event) => event.type)).not.toContain("request.opened");
      const requests = yield* readRequestLog(requestLogPath);
      expect(requests.map((request) => request.result)).toContainEqual({
        outcome: { outcome: "selected", optionId: "allow-always" },
      });
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("gives the agent T3 MCP and offers client terminals to Devin only", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-devin");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-test"),
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:9/mcp",
        authorizationHeader: "Bearer mcp-secret",
        capabilities: new Set(),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const { adapter, requestLogPath } = yield* makeHarness({ wire, agentId: "devin" });
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.stopSession(threadId);

      const requests = yield* readRequestLog(requestLogPath);
      expect(requests.find((request) => request.method === "initialize")?.params).toMatchObject({
        clientCapabilities: { terminal: true },
      });
      expect(requests.find((request) => request.method === "session/new")?.params).toMatchObject({
        mcpServers: [
          {
            name: "t3-code",
            args: expect.arrayContaining(["acp-mcp-bridge"]),
            env: expect.arrayContaining([
              { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer mcp-secret" },
            ]),
          },
        ],
      });
    }).pipe(Effect.scoped, TestClock.withLive),
  );
}
