import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AutonomyLevel,
  DroidInteractionMode,
  DroidMessageType,
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
const threadId = ThreadId.make("thread-droid");

function fakeSession(input: {
  readonly sessionId?: string;
  readonly messages?: ReadonlyArray<DroidMessage>;
  readonly onStream?: () => AsyncGenerator<DroidMessage, void, undefined>;
}): DroidSession {
  return {
    sessionId: input.sessionId ?? "droid-session-1",
    initResult: { sessionId: input.sessionId ?? "droid-session-1" },
    stream: () =>
      input.onStream?.() ??
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
    interrupt: async () => undefined,
    close: async () => undefined,
    updateSettings: async () => ({}),
    enterSpecMode: async () => ({}),
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

it.effect("reads and rolls back Droid thread snapshots", () =>
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
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* adapter.sendTurn({ threadId, input: "second" });

      const before = yield* adapter.readThread(threadId);
      assert.equal(before.turns.length, 2);
      const after = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(after.turns.length, 1);
      assert.equal(after.turns[0]?.id, before.turns[0]?.id);

      const invalid = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.exit);
      assert.equal(invalid._tag, "Failure");
    }),
  ).pipe(Effect.provide(testLayer)),
);
