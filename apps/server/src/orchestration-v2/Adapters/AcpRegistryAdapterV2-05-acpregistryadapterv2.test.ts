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
  it.effect("settles Claude's accepted foreground reply while retaining child output", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["accepted", "child-output", "wake"]);
      const { update, idle, prompt } = claudeFrames;
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          prompt(1)[0],
          idle("end_turn"),
          claudeMarker("before acceptance"),
          { ...prompt(1)[1], label: "accepted" },
          ...prompt(1).slice(2),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "agent-1",
            name: "Agent",
            title: "Review",
            kind: "think",
            status: "pending",
            rawInput: { description: "Review" },
          }),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "malformed-agent",
            name: "Agent",
            title: "Incomplete agent",
            kind: "think",
            status: "pending",
            rawInput: { description: "Never receives a prompt" },
          }),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "failed-task",
            name: "Task",
            title: "Malformed task",
            kind: "think",
            status: "failed",
            rawInput: { description: "Missing prompt" },
          }),
          ...claudeChild.slice(0, 2),
          update("child-1", {
            sessionUpdate: "agent_message_chunk",
            messageId: "early-reply",
            content: { type: "text", text: "First review result." },
          }),
          claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
          ...claudeChild.slice(2),
          update("child-1", { sessionUpdate: "state_update", state: "running" }),
          ...claudeUnrelatedChildren,
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "agent_message_chunk",
            messageId: "reply",
            content: { type: "text", text: "The review is running." },
          }),
          idle("end_turn"),
          {
            ...update("child-1", {
              sessionUpdate: "agent_message_chunk",
              messageId: "child-reply",
              content: { type: "text", text: "Found the regression." },
            }),
            label: "child-output",
          },
          update("child-1", {
            sessionUpdate: "usage_update",
            used: 2_500,
            size: 10_000,
            cost: { amount: 0.42, currency: "USD" },
          }),
          update("child-1", {
            sessionUpdate: "session_info_update",
            title: "Child review",
            updatedAt: "2026-10-19T00:00:00Z",
          }),
          update("child-1", {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
            usage: { totalTokens: 3_000, inputTokens: 2_500, outputTokens: 500, thoughtTokens: 0 },
          }),
          claudeMarker("child output"),
          {
            ...update(CLAUDE_ROOT_SESSION, {
              sessionUpdate: "user_message",
              messageId: "wake-user",
              content: [{ type: "text", text: "Continue the review." }],
            }),
            label: "wake",
          },
          idle("end_turn"),
          claudeMarker("continuation idle"),
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        gate,
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const beforeAcceptance = yield* session.throughMarker("before acceptance");
      assert.isFalse(beforeAcceptance.some((event) => event.type === "turn.terminal"));
      gate.release("accepted");
      const foreground = yield* session.until((event) => event.type === "turn.terminal");
      const foregroundTerminal = foreground.at(-1)!;
      if (foregroundTerminal.type !== "turn.terminal")
        throw new Error("Missing foreground terminal");
      assert.equal(foregroundTerminal.status, "completed");
      const earlyResult = foreground.findLast(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isDefined(earlyResult, "a child can finish before its spawn acknowledgement");
      if (earlyResult?.type !== "subagent.updated") throw new Error("Missing early result");
      assert.equal(earlyResult.subagent.result, "First review result.");
      const earlyItem = foreground.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      if (earlyItem?.type !== "turn_item.updated" || earlyItem.turnItem.type !== "subagent")
        throw new Error("Missing early parent item");
      assert.equal(earlyItem.turnItem.result, "First review result.");
      assert.isTrue(yield* session.runtime.hasPendingBackgroundWork!);
      gate.release("child-output");
      const childOutput = yield* session.throughMarker("child output");
      const message = childOutput.find(
        (event) =>
          event.type === "message.updated" && event.message.text === "Found the regression.",
      );
      assert.isDefined(message, "child output survives foreground completion");
      if (message?.type !== "message.updated") throw new Error("Missing child output");
      assert.notEqual(message.message.threadId, session.turnInput(1).threadId);
      const childThreads = childOutput.flatMap((event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.appThreadId === message.message.threadId
          ? [event.providerThread]
          : [],
      );
      assert.deepEqual(
        childThreads.map((thread) => thread.contextUsage),
        [
          { usedTokens: 2_500, maxTokens: 10_000, cost: { amount: 0.42, currency: "USD" } },
          { usedTokens: 2_500, maxTokens: 10_000, cost: { amount: 0.42, currency: "USD" } },
        ],
      );
      assert.deepEqual(childThreads.at(-1)?.nativeMetadata, {
        title: "Child review",
        updatedAt: "2026-10-19T00:00:00Z",
      });
      assert.isFalse(childOutput.some((event) => event.type === "turn.terminal"));
      assert.isTrue(
        childOutput.some(
          (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
        ),
      );
      const latestChild = childOutput.findLast((event) => event.type === "subagent.updated");
      if (latestChild?.type !== "subagent.updated") throw new Error("Missing current child result");
      assert.equal(latestChild.subagent.result, "Found the regression.");
      const rootItems = new Map(
        [...foreground, ...childOutput].flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.threadId === session.turnInput(1).threadId
            ? [[event.turnItem.id, event.turnItem] as const]
            : [],
        ),
      );
      const generic = [...rootItems.values()].filter((item) => item.type === "dynamic_tool");
      assert.isFalse(
        generic.some((item) => item.nativeItemRef?.nativeId === "agent-1"),
        "native subagents never project a duplicate generic tool",
      );
      const malformed = generic.find((item) => item.nativeItemRef?.nativeId === "malformed-agent");
      assert.isDefined(malformed, "unclassified tools still project on foreground completion");
      assert.equal(malformed?.status, "completed");
      const failed = generic.find((item) => item.nativeItemRef?.nativeId === "failed-task");
      assert.isDefined(failed, "unclassified terminal tools retain ordinary failures");
      assert.equal(failed?.status, "failed");
      assert.isFalse(
        [...rootItems.values()].some((item) => item.type === "user_message"),
        "the submitted root prompt is already owned by the app",
      );
      assert.deepEqual(pendingBackgroundTurnItems({ turnItems: [...rootItems.values()] }), []);
      assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);
      gate.release("wake");
      yield* Queue.take(session.offered);
      yield* session.throughMarker("continuation idle");
      const offer = session.offers[0]!;
      yield* offer.dispatchIfCurrent!(Effect.void);
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      const terminal = continuation.at(-1)!;
      if (terminal.type !== "turn.terminal") throw new Error("Missing continuation terminal");
      assert.equal(
        terminal.status,
        "completed",
        "buffered acceptance preserves the latest live idle",
      );
      assert.isFalse(
        continuation.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "user_message",
        ),
        "autonomous root echoes only signal acceptance",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

