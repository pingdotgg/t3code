import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import { SparrowSettings } from "@t3tools/provider-sparrow/settings";
import {
  makeSparrowAdapterV2,
  SPARROW_ACP_CANCEL_BEHAVIOR,
  SPARROW_DRIVER_KIND,
} from "@t3tools/provider-sparrow/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const SESSION_ID = "sparrow-session-01";
const ENABLED_SPARROW_SETTINGS = Schema.decodeSync(SparrowSettings)({ enabled: true });

type Frame = Record<string, unknown>;
const outbound = (method: string, params: unknown = "<any>"): Frame => ({
  type: "expect_outbound",
  label: method,
  frame: { kind: "request", method, params },
});
const answer = (method: string, result: unknown): Frame => ({
  type: "emit_inbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});
const inboundNotification = (method: string, params: unknown): Frame => ({
  type: "emit_inbound",
  label: method,
  frame: { kind: "notification", method, params },
});
const inboundRequest = (method: string, params: unknown): Frame => ({
  type: "emit_inbound",
  label: method,
  frame: { kind: "request", method, params },
});
const expectResponse = (method: string, result: unknown): Frame => ({
  type: "expect_outbound",
  label: `${method}.result`,
  frame: { kind: "response", method, result },
});

const sparrowConfig = (
  model: string,
  thoughtLevel: string,
  permissionMode: "read_only" | "workspace_write" | "full_access" = "workspace_write",
) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "openai-codex/gpt-5.5", name: "GPT-5.5" },
      { value: "magpie/group/flash", name: "Magpie Flash" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: thoughtLevel,
    options: [
      { value: "off", name: "Off" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  {
    id: "permission_mode",
    name: "Permission mode",
    category: "mode",
    type: "select",
    currentValue: permissionMode,
    options: [
      { value: "read_only", name: "Read-only" },
      { value: "workspace_write", name: "Workspace write" },
      { value: "full_access", name: "Full access" },
    ],
  },
];

const sparrowInitialize: ReadonlyArray<Frame> = [
  outbound("initialize", {
    protocolVersion: "<any>",
    capabilities: "<any>",
    info: "<any>",
    clientCapabilities: {
      fs: "<any>",
      terminal: "<any>",
      session: "<any>",
      elicitation: "<any>",
      _meta: { sparrow: { permissions: { gateReads: true } } },
    },
    clientInfo: "<any>",
  }),
  answer("initialize", {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
      _meta: {
        "sparrow/session": { version: 1 },
        "sparrow/permissions": {
          version: 1,
          modes: ["read_only", "workspace_write", "full_access"],
          gateReads: true,
        },
      },
    },
    agentInfo: { name: "sparrow", version: "0.14.0" },
    authMethods: [{ id: "chatgpt", name: "ChatGPT device-code login" }],
  }),
];

const runSparrowScenario = Effect.fn("runSparrowScenario")(function* (input: {
  readonly scenario: string;
  readonly frames: ReadonlyArray<Frame>;
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
  readonly model: string;
  readonly thoughtLevel?: string;
  readonly promptText?: string;
  readonly approvalDecision?: "accept" | "decline";
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: `t3-sparrow-${input.scenario}-`,
  });
  const statusPath = path.join(replayDir, "status.json");
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: SPARROW_DRIVER_KIND,
      protocol: ACP_PROTOCOL,
      version: "1",
      scenario: input.scenario,
      entries: input.frames as never,
    },
    SPARROW_DRIVER_KIND,
  );
  const instanceId = ProviderInstanceId.make(`sparrow-${input.scenario}`);
  const adapter = yield* makeSparrowAdapterV2({
    instanceId,
    settings: ENABLED_SPARROW_SETTINGS,
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    makeRuntime: makeAcpReplayRuntime({
      transcript,
      statusPath,
      scriptPath: yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      ),
      childProcessSpawner,
      fileSystem,
      cancelBehavior: SPARROW_ACP_CANCEL_BEHAVIOR,
    }),
  });
  const threadId = ThreadId.make(`thread-sparrow-${input.scenario}`);
  const modelSelection = createModelSelection(
    instanceId,
    input.model,
    input.thoughtLevel ? [{ id: "thought_level", value: input.thoughtLevel }] : undefined,
  );
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
  const collectedEvents: Array<unknown> = [];
  yield* Effect.gen(function* () {
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-sparrow-${input.scenario}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${threadId}`),
        title: "Sparrow adapter test",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run:${threadId}:1`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt:${threadId}:1`),
      rootNodeId: NodeId.make(`node:${threadId}:1`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${threadId}:1`),
        text: input.promptText ?? "Say hello",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const events = yield* session.events.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          if (
            input.approvalDecision !== undefined &&
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.status === "pending"
          ) {
            yield* session.respondToRuntimeRequest({
              requestId: event.runtimeRequest.id,
              decision: input.approvalDecision,
            });
          }
          return event;
        }),
      ),
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    collectedEvents.push(...events);
  }).pipe(Effect.scoped);
  yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
  return collectedEvents;
});

describe("SparrowAdapterV2", () => {
  it.effect(
    "switches model before thought_level and picks allow_once on auto-approved permissions",
    () =>
      runSparrowScenario({
        scenario: "model-thought-and-permission",
        runtimeMode: "full-access",
        model: "magpie/group/flash",
        thoughtLevel: "max",
        frames: [
          ...sparrowInitialize,
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: SESSION_ID,
            configOptions: sparrowConfig("openai-codex/gpt-5.5", "high"),
          }),
          outbound("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "model",
            value: "magpie/group/flash",
          }),
          answer("session/set_config_option", {
            configOptions: sparrowConfig("magpie/group/flash", "high"),
          }),
          outbound("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "thought_level",
            value: "max",
          }),
          answer("session/set_config_option", {
            configOptions: sparrowConfig("magpie/group/flash", "max"),
          }),
          outbound("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "permission_mode",
            value: "full_access",
          }),
          answer("session/set_config_option", {
            configOptions: sparrowConfig("magpie/group/flash", "max", "full_access"),
          }),
          outbound("session/prompt", { sessionId: SESSION_ID, prompt: "<any>" }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run ls" },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "allow_once" },
          }),
          inboundNotification("session/update", {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello from Sparrow" },
            },
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          outbound("session/close", { sessionId: SESSION_ID }),
          answer("session/close", {}),
        ],
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("routes /compact through _sparrow/session extension method", () =>
    Effect.gen(function* () {
      const events = yield* runSparrowScenario({
        scenario: "compact",
        runtimeMode: "workspace-write",
        model: "default",
        promptText: "/compact",
        frames: [
          ...sparrowInitialize,
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: SESSION_ID,
            configOptions: sparrowConfig("magpie/group/flash", "max"),
          }),
          outbound("_sparrow/session", {
            sessionId: SESSION_ID,
            action: { type: "compact" },
          }),
          answer("_sparrow/session", { stopReason: "end_turn" }),
          outbound("session/close", { sessionId: SESSION_ID }),
          answer("session/close", {}),
        ],
      });
      assert.isTrue(events.length > 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "auto-allows workspace edits and confined bash in workspace-write mode while escalating out-of-workspace requests",
    () =>
      runSparrowScenario({
        scenario: "workspace-write-policy",
        runtimeMode: "workspace-write",
        approvalDecision: "decline",
        model: "default",
        frames: [
          ...sparrowInitialize,
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: SESSION_ID,
            configOptions: sparrowConfig("magpie/group/flash", "max", "workspace_write"),
          }),
          outbound("session/prompt", { sessionId: SESSION_ID, prompt: "<any>" }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "edit-inside",
              kind: "edit",
              title: "edit: write",
              locations: [{ path: "<workspace>/src/index.ts" }],
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "allow_once" },
          }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "bash-confined",
              kind: "execute",
              title: "execute: bash",
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "allow_once" },
          }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "edit-outside",
              kind: "edit",
              title: "edit: write",
              locations: [{ path: "/etc/hosts" }],
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "deny" },
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          outbound("session/close", { sessionId: SESSION_ID }),
          answer("session/close", {}),
        ],
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "applies read_only permission_mode and enforces restricted read roots and networkAccess",
    () =>
      runSparrowScenario({
        scenario: "read-only-restricted",
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: ["allowed"],
          },
          networkAccess: false,
        },
        model: "default",
        frames: [
          ...sparrowInitialize,
          outbound("session/new", { cwd: "<workspace>", mcpServers: "<any>" }),
          answer("session/new", {
            sessionId: SESSION_ID,
            configOptions: sparrowConfig("magpie/group/flash", "max"),
          }),
          outbound("session/set_config_option", {
            sessionId: SESSION_ID,
            configId: "permission_mode",
            value: "read_only",
          }),
          answer("session/set_config_option", {
            configOptions: sparrowConfig("magpie/group/flash", "max", "read_only"),
          }),
          outbound("session/prompt", { sessionId: SESSION_ID, prompt: "<any>" }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "read-allowed",
              kind: "read",
              title: "read: read",
              locations: [{ path: "<workspace>/allowed/file.txt" }],
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "allow_once" },
          }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "read-secret",
              kind: "read",
              title: "read: read",
              locations: [{ path: "<workspace>/secret.txt" }],
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "deny" },
          }),
          inboundRequest("session/request_permission", {
            sessionId: SESSION_ID,
            toolCall: {
              toolCallId: "web-search",
              kind: "search",
              title: "search: web_search",
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }),
          expectResponse("session/request_permission", {
            outcome: { outcome: "selected", optionId: "deny" },
          }),
          answer("session/prompt", { stopReason: "end_turn" }),
          outbound("session/close", { sessionId: SESSION_ID }),
          answer("session/close", {}),
        ],
      }).pipe(Effect.provide(testLayer)),
  );
});
