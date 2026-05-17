import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AutonomyLevel,
  DroidErrorType,
  DroidInteractionMode,
  DroidMessageType,
  DroidWorkingState,
  type MessageOptions,
  ReasoningEffort,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type CreateSessionOptions,
  type DroidMessage,
  type DroidSession,
  type RequestPermissionRequestParams,
} from "@factory/droid-sdk";
import {
  ApprovalRequestId,
  ChatAttachment,
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeDroidAdapter } from "./DroidAdapter.ts";

const settings = Schema.decodeSync(DroidSettings)({
  enabled: true,
  binaryPath: "fake-droid",
});
const decodeChatAttachment = Schema.decodeSync(ChatAttachment);
const threadId = ThreadId.make("thread-droid");

function fakeSession(input: {
  readonly sessionId?: string;
  readonly messages?: ReadonlyArray<DroidMessage>;
  readonly onStream?: (options?: MessageOptions) => AsyncGenerator<DroidMessage, void, undefined>;
  readonly onClose?: () => Promise<void>;
  readonly onInterrupt?: () => Promise<void>;
  readonly onEnterSpecMode?: (params: unknown) => void;
  readonly onUpdateSettings?: (params: unknown) => void;
}): DroidSession {
  return {
    sessionId: input.sessionId ?? "droid-session-1",
    initResult: { sessionId: input.sessionId ?? "droid-session-1" },
    stream: (_text: string, options?: MessageOptions) =>
      input.onStream?.(options) ??
      (async function* () {
        for (const message of input.messages ?? []) {
          yield message;
        }
      })(),
    send: async () => ({
      sessionId: input.sessionId ?? "droid-session-1",
      text: "",
      messages: [],
      tokenUsage: null,
      durationMs: 0,
      turnCount: 1,
      error: null,
      structuredOutput: null,
      success: true,
    }),
    interrupt: input.onInterrupt ?? (async () => undefined),
    close: input.onClose ?? (async () => undefined),
    updateSettings: async (params: unknown) => {
      input.onUpdateSettings?.(params);
      return {};
    },
    enterSpecMode: async (params: unknown) => {
      input.onEnterSpecMode?.(params);
      return {};
    },
  } as unknown as DroidSession;
}

const testLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("maps Droid SDK stream messages into canonical runtime events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let createOptions: CreateSessionOptions | undefined;
      const adapter = yield* makeDroidAdapter(settings, {
        instanceId: ProviderInstanceId.make("droid"),
        sdk: {
          createSession: async (options) => {
            createOptions = options;
            return fakeSession({
              messages: [
                {
                  type: DroidMessageType.AssistantTextDelta,
                  messageId: "m1",
                  blockIndex: 0,
                  text: "hi",
                },
                {
                  type: DroidMessageType.ToolUse,
                  toolName: "Execute",
                  toolInput: {},
                  toolUseId: "tool-1",
                },
                {
                  type: DroidMessageType.ToolProgress,
                  toolName: "Execute",
                  toolUseId: "tool-1",
                  content: "running",
                  update: { type: "status", status: "running", text: "running" },
                },
                {
                  type: DroidMessageType.ToolResult,
                  toolName: "Execute",
                  toolUseId: "tool-1",
                  content: "done",
                  isError: false,
                },
                {
                  type: DroidMessageType.TokenUsageUpdate,
                  inputTokens: 10,
                  outputTokens: 4,
                  cacheCreationTokens: 2,
                  cacheReadTokens: 3,
                  thinkingTokens: 1,
                },
                { type: DroidMessageType.SessionTitleUpdated, title: "Droid title" },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            });
          },
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(11),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "claude-sonnet", [
          { id: "reasoningEffort", value: "high" },
        ]),
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      assert.equal(createOptions?.modelId, "claude-sonnet");
      assert.equal(createOptions?.autonomyLevel, AutonomyLevel.High);
      assert.equal(createOptions?.interactionMode, DroidInteractionMode.Auto);
      assert.equal(createOptions?.reasoningEffort, ReasoningEffort.High);
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.started",
          "thread.started",
          "turn.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.completed",
          "thread.token-usage.updated",
          "thread.metadata.updated",
          "item.completed",
          "turn.completed",
        ],
      );
      const expectedUsage = {
        usedTokens: 20,
        inputTokens: 15,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        lastUsedTokens: 20,
        lastInputTokens: 15,
        lastCachedInputTokens: 3,
        lastOutputTokens: 5,
        lastReasoningOutputTokens: 1,
      };
      assert.deepEqual(
        events.find((event) => event.type === "thread.token-usage.updated")?.payload,
        { usage: expectedUsage },
      );
      assert.deepEqual(events.find((event) => event.type === "turn.completed")?.payload, {
        state: "completed",
        usage: expectedUsage,
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps Droid token usage cumulative across turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const usageThreadId = ThreadId.make("thread-droid-token-usage");
      let streamCalls = 0;
      const turnUsages: ReadonlyArray<DroidMessage> = [
        {
          type: DroidMessageType.TokenUsageUpdate,
          inputTokens: 10,
          outputTokens: 4,
          cacheCreationTokens: 2,
          cacheReadTokens: 3,
          thinkingTokens: 1,
        },
        {
          type: DroidMessageType.TokenUsageUpdate,
          inputTokens: 5,
          outputTokens: 7,
          cacheCreationTokens: 0,
          cacheReadTokens: 1,
          thinkingTokens: 2,
        },
      ];
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              onStream: async function* () {
                const usage = turnUsages[streamCalls];
                streamCalls += 1;
                if (!usage) throw new Error("Unexpected extra Droid turn stream.");
                yield usage;
                yield { type: DroidMessageType.TurnComplete, tokenUsage: null };
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const firstEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === usageThreadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: usageThreadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: usageThreadId, input: "first" });
      const firstEvents = Array.from(
        yield* Fiber.join(firstEventsFiber).pipe(Effect.timeout("2 seconds")),
      );

      const secondEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === usageThreadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId: usageThreadId, input: "second" });
      const secondEvents = Array.from(
        yield* Fiber.join(secondEventsFiber).pipe(Effect.timeout("2 seconds")),
      );
      const events = [...firstEvents, ...secondEvents];
      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");
      const completedTurns = events.filter((event) => event.type === "turn.completed");

      assert.deepEqual(
        usageEvents.map((event) =>
          event.type === "thread.token-usage.updated" ? event.payload.usage : undefined,
        ),
        [
          {
            usedTokens: 20,
            inputTokens: 15,
            cachedInputTokens: 3,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            lastUsedTokens: 20,
            lastInputTokens: 15,
            lastCachedInputTokens: 3,
            lastOutputTokens: 5,
            lastReasoningOutputTokens: 1,
          },
          {
            usedTokens: 35,
            inputTokens: 21,
            cachedInputTokens: 4,
            outputTokens: 14,
            reasoningOutputTokens: 3,
            lastUsedTokens: 15,
            lastInputTokens: 6,
            lastCachedInputTokens: 1,
            lastOutputTokens: 9,
            lastReasoningOutputTokens: 2,
          },
        ],
      );
      assert.deepEqual(
        completedTurns.map((event) =>
          event.type === "turn.completed"
            ? (event.payload as { usage?: { usedTokens?: number } }).usage?.usedTokens
            : undefined,
        ),
        [20, 35],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("accumulates multiple Droid token usage updates within one turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const usageThreadId = ThreadId.make("thread-droid-intra-turn-token-usage");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [
                {
                  type: DroidMessageType.TokenUsageUpdate,
                  inputTokens: 10,
                  outputTokens: 4,
                  cacheCreationTokens: 2,
                  cacheReadTokens: 3,
                  thinkingTokens: 1,
                },
                {
                  type: DroidMessageType.TokenUsageUpdate,
                  inputTokens: 5,
                  outputTokens: 7,
                  cacheCreationTokens: 0,
                  cacheReadTokens: 1,
                  thinkingTokens: 2,
                },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === usageThreadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: usageThreadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: usageThreadId, input: "count tokens" });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const usageEvents = events.filter((event) => event.type === "thread.token-usage.updated");

      assert.deepEqual(
        usageEvents.map((event) =>
          event.type === "thread.token-usage.updated" ? event.payload.usage : undefined,
        ),
        [
          {
            usedTokens: 20,
            inputTokens: 15,
            cachedInputTokens: 3,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            lastUsedTokens: 20,
            lastInputTokens: 15,
            lastCachedInputTokens: 3,
            lastOutputTokens: 5,
            lastReasoningOutputTokens: 1,
          },
          {
            usedTokens: 35,
            inputTokens: 21,
            cachedInputTokens: 4,
            outputTokens: 14,
            reasoningOutputTokens: 3,
            lastUsedTokens: 15,
            lastInputTokens: 6,
            lastCachedInputTokens: 1,
            lastOutputTokens: 9,
            lastReasoningOutputTokens: 2,
          },
        ],
      );
      assert.deepEqual(events.find((event) => event.type === "turn.completed")?.payload, {
        state: "completed",
        usage: {
          usedTokens: 35,
          inputTokens: 21,
          cachedInputTokens: 4,
          outputTokens: 14,
          reasoningOutputTokens: 3,
          lastUsedTokens: 15,
          lastInputTokens: 6,
          lastCachedInputTokens: 1,
          lastOutputTokens: 9,
          lastReasoningOutputTokens: 2,
        },
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("maps Droid medium access to medium autonomy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let createOptions: CreateSessionOptions | undefined;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async (options) => {
            createOptions = options;
            return fakeSession({
              messages: [{ type: DroidMessageType.TurnComplete, tokenUsage: null }],
            });
          },
          resumeSession: async () => fakeSession({}),
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "medium-access",
      });

      assert.equal(createOptions?.autonomyLevel, AutonomyLevel.Medium);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("updates Droid settings when resuming an existing session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let updateSettingsParams: unknown;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => fakeSession({}),
          resumeSession: async () =>
            fakeSession({
              onUpdateSettings: (params) => {
                updateSettingsParams = params;
              },
            }),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "medium-access",
        resumeCursor: "droid-session-existing",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "custom-model", [
          { id: "reasoningEffort", value: "high" },
        ]),
      });

      assert.deepEqual(updateSettingsParams, {
        autonomyLevel: AutonomyLevel.Medium,
        interactionMode: DroidInteractionMode.Auto,
        modelId: "custom-model",
        reasoningEffort: ReasoningEffort.High,
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("closes the previous Droid session before replacing a thread context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closedSessionIds: string[] = [];
      let createCalls = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => {
            createCalls += 1;
            const sessionId = `droid-session-${createCalls}`;
            return fakeSession({
              sessionId,
              onClose: async () => {
                closedSessionIds.push(sessionId);
              },
            });
          },
          resumeSession: async () => fakeSession({}),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });

      assert.deepEqual(closedSessionIds, ["droid-session-1"]);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.resumeCursor, "droid-session-2");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("uses final Droid create_message content when deltas are absent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [
                {
                  type: DroidMessageType.CreateMessage,
                  messageId: "assistant-final",
                  role: "assistant",
                  content: [
                    { type: "thinking", signature: "test-signature", thinking: "final thought" },
                    { type: "text", text: "final text" },
                  ],
                },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload : undefined)),
        [
          { streamKind: "reasoning_text", delta: "final thought" },
          { streamKind: "assistant_text", delta: "final text" },
        ],
      );
      const completed = events.find((event) => event.type === "item.completed");
      assert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        assert.equal(completed.payload.itemType, "assistant_message");
        assert.equal(completed.payload.detail, "final text");
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("does not duplicate Droid final create_message text after streaming deltas", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [
                {
                  type: DroidMessageType.AssistantTextDelta,
                  messageId: "assistant-streamed",
                  blockIndex: 0,
                  text: "stre",
                },
                {
                  type: DroidMessageType.AssistantTextDelta,
                  messageId: "assistant-streamed",
                  blockIndex: 0,
                  text: "am",
                },
                {
                  type: DroidMessageType.CreateMessage,
                  messageId: "assistant-streamed",
                  role: "assistant",
                  content: [{ type: "text", id: "sdk-text-block", text: "stream" }],
                },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(7),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : undefined)),
        ["stre", "am"],
      );
      const completed = events.find((event) => event.type === "item.completed");
      assert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        assert.equal(completed.payload.detail, "stream");
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("does not duplicate Droid final thinking content after streaming deltas", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [
                {
                  type: DroidMessageType.ThinkingTextDelta,
                  messageId: "assistant-thinking",
                  blockIndex: 0,
                  text: "thi",
                },
                {
                  type: DroidMessageType.ThinkingTextDelta,
                  messageId: "assistant-thinking",
                  blockIndex: 0,
                  text: "nk",
                },
                {
                  type: DroidMessageType.CreateMessage,
                  messageId: "assistant-thinking",
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      id: "sdk-thinking-block",
                      signature: "test-signature",
                      thinking: "think",
                    },
                    { type: "text", text: "answer" },
                  ],
                },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(8),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload : undefined)),
        [
          { streamKind: "reasoning_text", delta: "thi" },
          { streamKind: "reasoning_text", delta: "nk" },
          { streamKind: "assistant_text", delta: "answer" },
        ],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("ignores Droid interrupt failures after aborting the active turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let interruptAttempts = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [{ type: DroidMessageType.TurnComplete, tokenUsage: null }],
              onInterrupt: async () => {
                interruptAttempts += 1;
                throw new Error("interrupt failed");
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });

      const exit = yield* adapter.interruptTurn(threadId).pipe(Effect.exit);
      assert.equal(exit._tag, "Success");
      assert.equal(interruptAttempts, 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("completes aborted Droid streams as interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              onStream: async function* (options) {
                yield {
                  type: DroidMessageType.WorkingStateChanged,
                  state: DroidWorkingState.StreamingAssistantMessage,
                };
                while (!options?.abortSignal?.aborted) {
                  await Promise.resolve();
                }
                throw new DOMException("The operation was aborted.", "AbortError");
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "stop me" });
      yield* adapter.interruptTurn(threadId);

      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(completed._tag, "Some");
      if (completed._tag === "Some" && completed.value.type === "turn.completed") {
        assert.equal(completed.value.payload.state, "interrupted");
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("rejects overlapping Droid turns on the same thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let streamCalls = 0;
      let releaseTurn: (() => void) | undefined;
      const turnRelease = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              onStream: async function* () {
                streamCalls += 1;
                yield {
                  type: DroidMessageType.WorkingStateChanged,
                  state: DroidWorkingState.StreamingAssistantMessage,
                };
                await turnRelease;
                yield { type: DroidMessageType.TurnComplete, tokenUsage: null };
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "first" });
      const second = yield* adapter.sendTurn({ threadId, input: "second" }).pipe(Effect.exit);

      assert.equal(second._tag, "Failure");
      releaseTurn?.();
      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(completed._tag, "Some");
      assert.equal(streamCalls, 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("releases Droid turn reservation after attachment validation failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let streamCalls = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              onStream: async function* () {
                streamCalls += 1;
                yield { type: DroidMessageType.TurnComplete, tokenUsage: null };
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const unsupportedAttachment = decodeChatAttachment({
        type: "image",
        id: "thread-droid-tiff",
        name: "unsupported.tiff",
        mimeType: "image/tiff",
        sizeBytes: 1,
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      const failed = yield* adapter
        .sendTurn({ threadId, input: "", attachments: [unsupportedAttachment] })
        .pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");

      const recovered = yield* adapter
        .sendTurn({ threadId, input: "after failure" })
        .pipe(Effect.exit);
      assert.equal(recovered._tag, "Success");
      yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(streamCalls, 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("fails Droid turns when the SDK stream emits an error message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [
                {
                  type: DroidMessageType.Error,
                  message: "model exploded",
                  errorType: DroidErrorType.ERROR,
                  timestamp: "1970-01-01T00:00:00.000Z",
                },
                { type: DroidMessageType.TurnComplete, tokenUsage: null },
              ],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type !== "session.started" &&
            event.type !== "thread.started",
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "fail" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "runtime.error", "turn.completed"],
      );
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, "model exploded");
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("passes custom model reasoning into Droid spec mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let enterSpecModeParams: unknown;
      let updateSettingsParams: unknown;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [{ type: DroidMessageType.TurnComplete, tokenUsage: null }],
              onEnterSpecMode: (params) => {
                enterSpecModeParams = params;
              },
              onUpdateSettings: (params) => {
                updateSettingsParams = params;
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan",
        interactionMode: "plan",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("droid"),
          "custom:Direct-GPT-5.5-xhigh-27",
          [{ id: "reasoningEffort", value: "xhigh" }],
        ),
      });

      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(completed._tag, "Some");
      assert.deepEqual(enterSpecModeParams, {
        specModeModelId: "custom:Direct-GPT-5.5-xhigh-27",
        specModeReasoningEffort: ReasoningEffort.ExtraHigh,
      });
      assert.deepEqual(updateSettingsParams, {
        modelId: "custom:Direct-GPT-5.5-xhigh-27",
        reasoningEffort: ReasoningEffort.ExtraHigh,
        specModeModelId: "custom:Direct-GPT-5.5-xhigh-27",
        specModeReasoningEffort: ReasoningEffort.ExtraHigh,
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("routes Droid permission requests through adapter approvals", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let permissionResult: string | undefined;
      const permissionParams: RequestPermissionRequestParams = {
        options: [
          { label: "Proceed once", value: ToolConfirmationOutcome.ProceedOnce },
          { label: "Cancel", value: ToolConfirmationOutcome.Cancel },
        ],
        toolUses: [
          {
            toolUse: { type: "tool_use", id: "tool-1", input: {}, name: "Execute" },
            confirmationType: ToolConfirmationType.Execute,
            details: {
              type: ToolConfirmationType.Execute,
              fullCommand: "bun lint",
              command: "bun",
            },
          },
        ],
      };
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async (options) =>
            fakeSession({
              onStream: async function* () {
                const result = await options?.permissionHandler?.(permissionParams);
                permissionResult = typeof result === "string" ? result : result?.selectedOption;
                yield { type: DroidMessageType.TurnComplete, tokenUsage: null };
              },
            }),
          resumeSession: async () => fakeSession({}),
        },
      });
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run lint" });
      const opened = yield* Fiber.join(openedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(opened._tag, "Some");
      const requestId = opened.value.requestId;
      assert.ok(requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(requestId),
        "acceptForSession",
      );
      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(completed._tag, "Some");
      assert.equal(permissionResult, ToolConfirmationOutcome.ProceedAlways);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("continues stopping Droid sessions when one close fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closedSessionIds: string[] = [];
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => fakeSession({}),
          resumeSession: async (sessionId) =>
            fakeSession({
              sessionId,
              onClose: async () => {
                closedSessionIds.push(sessionId);
                if (sessionId === "droid-session-fails-close") {
                  throw new Error("close failed");
                }
              },
            }),
        },
      });

      const firstThreadId = ThreadId.make("thread-droid-close-1");
      const secondThreadId = ThreadId.make("thread-droid-close-2");
      yield* adapter.startSession({
        threadId: firstThreadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
        resumeCursor: "droid-session-fails-close",
      });
      yield* adapter.startSession({
        threadId: secondThreadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
        resumeCursor: "droid-session-closes",
      });

      yield* adapter.stopAll();

      assert.deepEqual(closedSessionIds.toSorted(), [
        "droid-session-closes",
        "droid-session-fails-close",
      ]);
      const sessions = yield* adapter.listSessions();
      assert.deepEqual(sessions, []);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("reads Droid thread snapshots and rejects unsupported rollback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession({
              messages: [{ type: DroidMessageType.TurnComplete, tokenUsage: null }],
            }),
          resumeSession: async () => fakeSession({}),
        },
      });

      const missing = yield* adapter
        .readThread(ThreadId.make("missing-droid-thread"))
        .pipe(Effect.exit);
      assert.equal(missing._tag, "Failure");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      const firstCompletedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* Fiber.join(firstCompletedFiber).pipe(Effect.timeout("2 seconds"));

      const secondCompletedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({ threadId, input: "second" });
      yield* Fiber.join(secondCompletedFiber).pipe(Effect.timeout("2 seconds"));

      const before = yield* adapter.readThread(threadId);
      assert.equal(before.turns.length, 2);
      const unsupported = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      assert.equal(unsupported._tag, "Failure");
      const after = yield* adapter.readThread(threadId);
      assert.equal(after.turns.length, 2);

      const invalid = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");
    }),
  ).pipe(Effect.provide(testLayer)),
);
