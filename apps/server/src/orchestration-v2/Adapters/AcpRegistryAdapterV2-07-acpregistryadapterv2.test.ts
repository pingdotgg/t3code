import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import type { AcpRegistryLiveConfiguration } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { t3AcpPromptWithInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  acpRegistryProbeResult,
} from "@t3tools/provider-acp-registry/testing";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const CLAUDE_ROOT_SESSION = "claude-session";

/** Replay frames of Claude Agent (claude-agent-acp 0.90.0) on ACP v2. */
const claudeFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 2,
          info: { name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0" },
          capabilities: { session: {} },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/new",
        result: { sessionId: CLAUDE_ROOT_SESSION },
      },
    },
  ],
  update: (sessionId: string, sessionUpdate: Record<string, unknown>) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId, update: sessionUpdate },
    },
  }),
  childState: (parent: string, child: string, state: string) =>
    claudeFrames.update(parent, {
      sessionUpdate: "subagent_update",
      sessionId: child,
      state: { state },
    }),
  /** A prompt Claude takes in and works on. */
  prompt: (ordinal: number) => [
    {
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: `user-${ordinal}`,
      content: [{ type: "text", text: "test prompt" }],
    }),
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { messageId: `user-${ordinal}` },
      },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, { sessionUpdate: "state_update", state: "running" }),
  ],
  idle: (stopReason: string) =>
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
    }),
  closeRequest: {
    type: "expect_outbound",
    frame: {
      kind: "request",
      method: "session/close",
      params: { sessionId: CLAUDE_ROOT_SESSION },
    },
  },
  closed: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/close", result: {} },
  },
};

const openClaudeReplaySession = Effect.fn("openClaudeReplaySession")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
  continuationEnabled = true,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-lifecycle-" });
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: "claude-lifecycle",
      entries: entries as never,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const offers: Array<ProviderContinuationRequest> = [];
  const offered = yield* Queue.unbounded<void>();
  const continuationRequests = {
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => {
        offers.push(request);
      }).pipe(Effect.andThen(Queue.offer(offered, undefined)), Effect.asVoid),
  };
  const instanceId = ProviderInstanceId.make("claude-lifecycle");
  let onTermination: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]
  > = () => Effect.die("Runtime has not started");
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath: path.join(replayDir, "status.json"),
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    ...(replayGate === undefined ? {} : { replayGate }),
  });
  const adapterOptions = {
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "claude-acp" }),
    environment: {},
    ...(continuationEnabled ? { continuationRequests } : {}),
    makeRuntime: (runtimeInput: Parameters<typeof replayRuntime>[0]) => {
      onTermination = runtimeInput.onTermination;
      return replayRuntime(runtimeInput);
    },
  };
  const adapter = yield* makeAcpRegistryAdapterV2(adapterOptions).pipe(
    Effect.provide(layerInjectedRuntimeCatalog),
  );
  const threadId = ThreadId.make("thread-claude-lifecycle");
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimeMode = "approval-required";
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-claude-lifecycle"),
    modelSelection,
    runtimePolicy,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => replayGate?.releaseAll()));
  if (continuationEnabled) {
    assert.isDefined(
      runtime.hasPendingBackgroundWork,
      "Claude ACP v2 must report background work after foreground idle",
    );
  }
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turnInput = (
    ordinal: number,
    options: { readonly continuation?: boolean } = {},
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project-claude-lifecycle`),
      title: "Claude Agent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
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
    runId: RunId.make(`run-claude-lifecycle-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-claude-lifecycle-${ordinal}`),
    rootNodeId: NodeId.make(`node-claude-lifecycle-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-claude-lifecycle-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    });
  const throughMarker = (title: string) =>
    until(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === title,
    );
  const terminal = until((event) => event.type === "turn.terminal").pipe(
    Effect.map((seen) => {
      const event = seen.at(-1)!;
      if (event.type !== "turn.terminal") throw new Error("Missing terminal");
      return event;
    }),
  );
  return {
    runtime,
    providerThread,
    turnInput,
    until,
    throughMarker,
    terminal,
    offers,
    offered,
    terminate: () =>
      onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected fixture process exit",
          cause: "test",
        }),
      ),
  };
});

const claudeMarker = (title: string) =>
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "session_info_update",
    title,
  });
const claudeChild = [
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    name: "Agent",
    title: "Review",
    kind: "think",
    status: "in_progress",
    rawInput: { prompt: "Review the code", description: "Review", run_in_background: true },
  }),
  claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
  claudeFrames.update("child-1", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: CLAUDE_ROOT_SESSION,
    recipientSessionId: "child-1",
    content: [{ type: "text", text: "Review the code" }],
  }),
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    status: "completed",
    _meta: { claudeCode: { toolResponse: { isAsync: true } } },
  }),
];

const claudeUnrelatedChildren = [
  claudeFrames.childState("unknown-parent", "unrelated-child", "running"),
  claudeFrames.update("unrelated-child", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: "unknown-parent",
    content: [{ type: "text", text: "Unrelated delegation" }],
  }),
  claudeFrames.update("unlinked-child", {
    sessionUpdate: "agent_message_chunk",
    messageId: "unlinked-reply",
    content: { type: "text", text: "Unlinked output" },
  }),
];



describe("AcpRegistryAdapterV2", () => {
  it.effect.each(["error", "end_turn"])(
    "hands live Claude child tools to the next run after %s and keeps nested output in the child",
    (stopReason) =>
      Effect.gen(function* () {
        const { update, childState, idle, prompt } = claudeFrames;
        const gate = makeProviderReplayGate(["nested-output", "nested-idle"]);
        const session = yield* openClaudeReplaySession(
          [
            ...claudeFrames.open,
            ...prompt(1),
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "tool_call_update",
              toolCallId: "agent-1",
              name: "Agent",
              title: "Review",
              kind: "think",
              status: "in_progress",
              rawInput: { prompt: "Review the code", description: "Review" },
            }),
            ...claudeChild.slice(1, -1),
            update("child-1", {
              sessionUpdate: "tool_call_update",
              toolCallId: "child-tool",
              name: "Bash",
              title: "Read package",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "cat package.json" },
            }),
            update("child-1", {
              sessionUpdate: "agent_message_chunk",
              messageId: "progress",
              content: { type: "text", text: "Review in progress." },
            }),
            idle(stopReason),
            ...prompt(2),
            childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
            update("child-1", {
              sessionUpdate: "session_message",
              messageId: "resume-child",
              senderSessionId: CLAUDE_ROOT_SESSION,
              recipientSessionId: "child-1",
              content: [{ type: "text", text: "Continue the review." }],
            }),
            claudeMarker("resumed"),
            childState("child-1", "grandchild", "running"),
            childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "tool_call_update",
              toolCallId: "agent-1",
              name: "Agent",
              status: "completed",
              rawInput: { prompt: "Review the code", description: "Review" },
            }),
            idle("end_turn"),
            {
              ...update("grandchild", {
                sessionUpdate: "terminal_update",
                terminalId: "nested-terminal",
                command: "/usr/bin/node /srv/t3/bin.ts acp-mcp-call orchestrator_capabilities {}",
              }),
              label: "nested-output",
            },
            update("grandchild", {
              sessionUpdate: "terminal_output_chunk",
              terminalId: "nested-terminal",
              data: Buffer.from("{}\n").toString("base64"),
            }),
            update("grandchild", {
              sessionUpdate: "terminal_update",
              terminalId: "nested-terminal",
              exitStatus: { exitCode: 0 },
            }),
            update("grandchild", {
              sessionUpdate: "tool_call_update",
              toolCallId: "terminal-tool",
              name: "Bash",
              title: "Run nested command",
              kind: "execute",
              status: "in_progress",
              content: [{ type: "terminal", terminalId: "nested-terminal" }],
            }),
            update("grandchild", {
              sessionUpdate: "tool_call_update",
              toolCallId: "nested-tool",
              name: "Bash",
              title: "Read nested package",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "cat nested/package.json" },
            }),
            update("grandchild", {
              sessionUpdate: "agent_message_chunk",
              messageId: "nested-reply",
              content: { type: "text", text: "Nested output" },
            }),
            update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "user_message",
              messageId: "nested-wake",
              content: [{ type: "text", text: "Continue the review." }],
            }),
            idle("end_turn"),
            claudeMarker("nested"),
            {
              ...childState("child-1", "grandchild", "idle"),
              label: "nested-idle",
            },
            claudeMarker("nested idle"),
            ...prompt(4),
            update("child-1", {
              sessionUpdate: "session_message",
              messageId: "second-review",
              senderSessionId: CLAUDE_ROOT_SESSION,
              recipientSessionId: "child-1",
              content: [{ type: "text", text: "Review the fix." }],
            }),
            childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
            update("child-1", {
              sessionUpdate: "agent_message_chunk",
              messageId: "nested-reply",
              content: { type: "text", text: "The fix is correct." },
            }),
            childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
            idle("end_turn"),
            claudeFrames.closeRequest,
            claudeFrames.closed,
          ],
          gate,
        );
        yield* session.runtime.startTurn(session.turnInput(1));
        const settled = yield* session.terminal;
        assert.equal(settled.status, stopReason === "error" ? "failed" : "completed");
        if (settled.status === "failed") assert.isTrue(settled.childTurnsContinue);
        yield* session.runtime.startTurn(session.turnInput(2));
        const resumed = yield* session.throughMarker("resumed");
        const row = resumed.find((event) => event.type === "subagent.updated");
        assert.isDefined(row);
        if (row?.type !== "subagent.updated") throw new Error("Missing resumed child");
        assert.equal(row.subagent.runId, session.turnInput(2).runId);
        assert.equal(
          row.subagent.result,
          "Review in progress.",
          "live handoff retains current execution progress",
        );
        assert.lengthOf(
          resumed.filter(
            (event) =>
              event.type === "message.updated" &&
              event.message.threadId === row.subagent.childThreadId &&
              event.message.role === "user" &&
              event.message.text === "Continue the review.",
          ),
          1,
          "child resume prompts remain visible once",
        );
        const openTools = resumed.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "running",
        );
        assert.lengthOf(openTools, 1, "handoff announces each open child tool once");
        const foreground = yield* session.until((event) => event.type === "turn.terminal");
        assert.isTrue(
          foreground.some(
            (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
          ),
          "the foreground Agent tool terminalizes its visible owner",
        );
        assert.isTrue(yield* session.runtime.hasPendingBackgroundWork!);
        gate.release("nested-output");
        const childOutput = yield* session.throughMarker("nested");
        yield* Queue.take(session.offered);
        assert.lengthOf(session.offers, 1);
        yield* session.offers[0]!.dispatchIfCurrent!(Effect.void);
        yield* session.runtime.startTurn(session.turnInput(3, { continuation: true }));
        const continued = yield* session.until((event) => event.type === "turn.terminal");
        const terminal = continued.at(-1)!;
        if (terminal.type !== "turn.terminal") throw new Error("Missing continuation terminal");
        assert.equal(terminal.status, "completed");
        const nested = [...childOutput, ...continued];
        const messages = nested.filter(
          (event) => event.type === "message.updated" && event.message.text === "Nested output",
        );
        assert.lengthOf(messages, 1);
        if (messages[0]?.type === "message.updated") {
          assert.equal(messages[0].message.threadId, row.subagent.childThreadId);
        }
        const nestedTool = nested.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId ===
              "agent-1:session:grandchild:tool:nested-tool",
        );
        assert.isDefined(nestedTool);
        if (nestedTool?.type === "turn_item.updated") {
          assert.equal(nestedTool.turnItem.threadId, row.subagent.childThreadId);
          if (nestedTool.turnItem.type === "dynamic_tool")
            assert.deepEqual(nestedTool.turnItem.input, { command: "cat nested/package.json" });
        }
        assert.isTrue(
          nested.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId ===
                "agent-1:session:grandchild:tool:terminal-tool" &&
              event.turnItem.threadId === row.subagent.childThreadId &&
              event.turnItem.toolName === "t3-code.orchestrator_capabilities",
          ),
          "embedded agent-terminal commands preserve nested MCP identity",
        );
        assert.isTrue(yield* session.runtime.hasPendingBackgroundWork!);
        gate.release("nested-idle");
        const finished = yield* session.throughMarker("nested idle");
        assert.isTrue(
          finished.some(
            (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
          ),
        );
        assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);
        assert.lengthOf(session.offers, 1, "nested frames make progress in one continuation");
        const firstResult = finished.findLast((event) => event.type === "subagent.updated");
        if (firstResult?.type !== "subagent.updated")
          throw new Error("Missing first review result");
        assert.equal(
          firstResult.subagent.result,
          "Review in progress.",
          "reopening the visible owner for a running descendant keeps its execution result",
        );
        yield* session.runtime.startTurn(session.turnInput(4));
        const reviewed = yield* session.until((event) => event.type === "turn.terminal");
        const currentResult = reviewed.findLast((event) => event.type === "subagent.updated");
        if (currentResult?.type !== "subagent.updated")
          throw new Error("Missing second review result");
        assert.equal(currentResult.subagent.id, row.subagent.id);
        assert.equal(currentResult.subagent.childThreadId, row.subagent.childThreadId);
        assert.equal(currentResult.subagent.result, "The fix is correct.");
        const currentItem = reviewed.findLast(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "subagent",
        );
        if (currentItem?.type !== "turn_item.updated" || currentItem.turnItem.type !== "subagent")
          throw new Error("Missing current parent item");
        assert.equal(currentItem.turnItem.result, "The fix is correct.");
        assert.lengthOf(
          reviewed.filter(
            (event) =>
              event.type === "message.updated" && event.message.text === "The fix is correct.",
          ),
          1,
          "a new execution does not append the previous execution's text",
        );
        assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

