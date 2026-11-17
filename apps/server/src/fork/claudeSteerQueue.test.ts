import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const sessionId = "native-thread-claude-steer";
const threadId = ThreadId.make("thread-claude-steer");
const attemptId = RunAttemptId.make("attempt-claude-steer");
const modelSelection = {
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  model: "claude-sonnet-4-6",
};
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const steerReply = "STEER_DONE";
const settings = Schema.decodeSync(ClaudeSettings)({});

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const result = (input: {
  readonly uuid: string;
  readonly userMessageUuids: ReadonlyArray<string>;
  readonly terminalReason?: string;
}) =>
  frame({
    type: "result",
    subtype: "success",
    uuid: input.uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: input.terminalReason ?? "completed",
    user_message_uuids: input.userMessageUuids,
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const assistantText = (text: string) =>
  frame({
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000921",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: "msg_steer",
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

// Starts a Claude turn on a fake query, steers it, and returns the prompt and steer as offered.
const startSteeredTurn = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
  const offers: SDKUserMessage[] = [];
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: modelSelection.instanceId,
    settings,
    environment: {},
    attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-steer-" }),
    fileSystem,
    path: yield* Path.Path,
    random: yield* SecureRandom.SecureRandom,
    idAllocator,
    queryRunner: {
      allocateSessionId: Effect.succeed(sessionId),
      open: () =>
        Effect.succeed({
          messages: Stream.fromQueue(sdkMessages),
          offer: (message) => Effect.sync(() => void offers.push(message)),
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          setPermissionMode: () => Effect.void,
          renameSession: () => Effect.void,
          backgroundTasks: () => Effect.succeed(false),
          mcpServerStatus: Effect.succeed([]),
          readMcpResource: () => Effect.die("unexpected MCP resource read"),
          callMcpTool: () => Effect.die("unexpected MCP tool call"),
          listPermissionRules: Effect.die("unexpected permission rules read"),
          stopTask: () => Effect.void,
          interrupt: Effect.die("a steer must not interrupt"),
          close: Effect.void,
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      subagentModel: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-steer"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminals = yield* Queue.unbounded<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event.type === "turn.terminal" ? Queue.offer(terminals, undefined) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  const now = yield* DateTime.now;
  const runId = RunId.make("run-claude-steer");
  yield* runtime.startTurn({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-claude-steer"),
      title: "Claude steer test",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
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
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make("node-claude-steer"),
    providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message-claude-steer-prompt"),
      text: "Audit the settings pages.",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  yield* runtime.steerTurn({
    threadId,
    runId,
    providerThread,
    providerTurnId: idAllocator.derive.providerTurn({
      driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
      nativeTurnId: `turn:${attemptId}`,
    }),
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("message-claude-steer"),
      text: "Include the hierarchy mock.",
      attachments: [],
    },
  });
  const [prompt, steer] = offers;
  assert.isUndefined(steer?.priority);
  if (prompt?.uuid === undefined || steer?.uuid === undefined) {
    return yield* Effect.die("prompt and steer must carry uuids");
  }
  const terminalIndex = () => events.findIndex((event) => event.type === "turn.terminal");
  const replyIndex = () =>
    events.findIndex(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "assistant_message" &&
        event.turnItem.text === steerReply,
    );
  return {
    sdkMessages,
    promptUuid: prompt.uuid,
    steerUuid: steer.uuid,
    events,
    terminalIndex,
    replyIndex,
    awaitTerminal: Queue.take(terminals),
  };
});

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

it.effect("keeps a steered turn open until Claude runs the queued steer", () =>
  Effect.gen(function* () {
    const turn = yield* startSteeredTurn;
    // The turn ended before Claude read the steer, so Claude runs it as its next turn.
    yield* Queue.offer(
      turn.sdkMessages,
      result({ uuid: "00000000-0000-4000-8000-000000000911", userMessageUuids: [turn.promptUuid] }),
    );
    yield* Queue.offer(turn.sdkMessages, assistantText(steerReply));
    yield* Queue.offer(
      turn.sdkMessages,
      result({ uuid: "00000000-0000-4000-8000-000000000912", userMessageUuids: [turn.steerUuid] }),
    );
    yield* turn.awaitTerminal;
    assert.isAbove(turn.replyIndex(), -1);
    assert.isAbove(turn.terminalIndex(), turn.replyIndex());
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("ends a steered turn on an aborted result that answered the steer", () =>
  Effect.gen(function* () {
    const turn = yield* startSteeredTurn;
    yield* Queue.offer(turn.sdkMessages, assistantText(steerReply));
    yield* Queue.offer(
      turn.sdkMessages,
      result({
        uuid: "00000000-0000-4000-8000-000000000913",
        userMessageUuids: [turn.promptUuid, turn.steerUuid],
        terminalReason: "aborted_tools",
      }),
    );
    yield* turn.awaitTerminal;
    assert.equal(turn.events.filter((event) => event.type === "turn.terminal").length, 1);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
