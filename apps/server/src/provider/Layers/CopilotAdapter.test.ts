import assert from "node:assert/strict";

import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import type { CopilotClient } from "@github/copilot-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakeSessionConfig = {
  readonly onPermissionRequest?: (...args: ReadonlyArray<unknown>) => Promise<unknown>;
  readonly onUserInputRequest?: (...args: ReadonlyArray<unknown>) => Promise<unknown>;
};

class FakeCopilotSession {
  handler: ((event: never) => void) | null = null;

  constructor(readonly sessionId: string) {}

  destroy = vi.fn(async () => undefined);
  on = vi.fn((handler: (event: never) => void) => {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  });
  send = vi.fn(async () => "message-1");
  abort = vi.fn(async () => undefined);
  getMessages = vi.fn(async () => []);

  emit(event: unknown) {
    this.handler?.(event as never);
  }
}

class FakeCopilotClient {
  connected = false;
  readonly callLog: string[] = [];
  readonly session = new FakeCopilotSession("session-1");
  lastCreateSessionConfig: FakeSessionConfig | undefined;

  start = vi.fn(async () => {
    this.callLog.push("start");
    this.connected = true;
  });

  listModels = vi.fn(async () => {
    this.callLog.push("listModels");
    if (!this.connected) {
      throw new Error("Client not connected");
    }
    return [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        capabilities: {
          supports: {
            vision: false,
            reasoningEffort: false,
          },
          limits: {
            max_context_window_tokens: 200_000,
          },
        },
      },
    ];
  });

  createSession = vi.fn(async (config: FakeSessionConfig) => {
    this.callLog.push("createSession");
    this.lastCreateSessionConfig = config;
    return this.session;
  });

  resumeSession = vi.fn(async () => {
    this.callLog.push("resumeSession");
    return this.session;
  });

  stop = vi.fn(async () => []);
}

const fakeClient = new FakeCopilotClient();
const layer = it.layer(
  makeCopilotAdapterLive({
    clientFactory: () => fakeClient as unknown as CopilotClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("CopilotAdapterLive startup", (it) => {
  it.effect("starts the SDK client before model validation on new sessions", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.start.mockClear();
      fakeClient.listModels.mockClear();
      fakeClient.createSession.mockClear();

      const adapter = yield* CopilotAdapter;
      const session = yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-start"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "copilot");
      assert.equal(session.threadId, "thread-copilot-start");
      assert.deepStrictEqual(fakeClient.callLog, ["start", "listModels", "createSession"]);
      assert.equal(fakeClient.start.mock.calls.length, 1);
      assert.equal(fakeClient.listModels.mock.calls.length, 1);
      assert.equal(fakeClient.createSession.mock.calls.length, 1);
    }),
  );

  it.effect("keeps a stable orchestration turn id for Copilot tool and approval events", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.lastCreateSessionConfig = undefined;
      fakeClient.session.handler = null;

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-turn-map"),
        model: "gpt-5.4",
        runtimeMode: "approval-required",
      });

      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.asVoid);

      const runtimeEventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, 7),
      ).pipe(Effect.forkChild);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-turn-map"),
        input: "update bb.py",
      });

      fakeClient.session.emit({
        id: "evt-tool-start",
        type: "tool.execution_start",
        timestamp: "2026-03-07T09:49:27.832Z",
        data: {
          toolCallId: "tool-1",
          toolName: "bash",
          arguments: "python3 bb.py",
        },
      });

      const onPermissionRequest = (fakeClient.lastCreateSessionConfig as
        | FakeSessionConfig
        | undefined)?.onPermissionRequest;
      if (onPermissionRequest) {
        void onPermissionRequest({
          kind: "read",
          path: "/Users/zortos/junk/bb.py",
        } as never);
      }

      fakeClient.session.emit({
        id: "evt-turn-start",
        type: "assistant.turn_start",
        timestamp: "2026-03-07T09:49:56.130Z",
        data: {
          turnId: "provider-turn-1",
        },
      });

      fakeClient.session.emit({
        id: "evt-tool-complete",
        type: "tool.execution_complete",
        timestamp: "2026-03-07T09:49:56.131Z",
        data: {
          toolCallId: "tool-1",
          toolName: "bash",
          success: true,
          result: {
            content: "ok",
            contents: [{ type: "terminal", text: "ok" }],
          },
        },
      });

      fakeClient.session.emit({
        id: "evt-assistant-message",
        type: "assistant.message",
        timestamp: "2026-03-07T09:49:57.807Z",
        data: {
          messageId: "msg-1",
          content: "Updated bb.py",
        },
      });

      fakeClient.session.emit({
        id: "evt-turn-end",
        type: "assistant.turn_end",
        timestamp: "2026-03-07T09:49:57.808Z",
        data: {
          turnId: "provider-turn-1",
        },
      });

      const events = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(
          Effect.map((chunk): ReadonlyArray<ProviderRuntimeEvent> => Array.from(chunk)),
        ),
      );
      const toolStarted = events.find((event) => event.type === "item.started");
      const approvalOpened = events.find((event) => event.type === "request.opened");
      const turnStarted = events.find((event) => event.type === "turn.started");
      const toolCompleted = events.find(
        (event) => event.type === "item.completed" && event.itemId === "tool-1",
      );

      assert.equal(turn.turnId.startsWith("copilot-turn-"), true);
      assert.equal(toolStarted?.turnId, turn.turnId);
      assert.equal(approvalOpened?.turnId, turn.turnId);
      assert.ok(turnStarted);
      assert.equal(turnStarted?.turnId, turn.turnId);
      assert.equal(turnStarted?.providerRefs?.providerTurnId, "provider-turn-1");
      assert.equal(toolCompleted?.turnId, turn.turnId);
      assert.equal(
        toolCompleted?.type === "item.completed" ? toolCompleted.payload.title : undefined,
        "bash",
      );
    }),
  );

  it.effect("waits for assistant usage before marking a Copilot turn complete", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.lastCreateSessionConfig = undefined;
      fakeClient.session.handler = null;

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-usage-complete"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });

      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.asVoid);

      const runtimeEventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, 7),
      ).pipe(Effect.forkChild);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-usage-complete"),
        input: "ship it",
      });

      fakeClient.session.emit({
        id: "evt-turn-start-usage",
        type: "assistant.turn_start",
        timestamp: "2026-03-08T10:00:00.000Z",
        data: {
          turnId: "provider-turn-usage-1",
        },
      });

      fakeClient.session.emit({
        id: "evt-assistant-message-usage",
        type: "assistant.message",
        timestamp: "2026-03-08T10:00:01.000Z",
        data: {
          messageId: "msg-usage-1",
          content: "Almost done",
        },
      });

      fakeClient.session.emit({
        id: "evt-turn-end-usage",
        type: "assistant.turn_end",
        timestamp: "2026-03-08T10:00:02.000Z",
        data: {
          turnId: "provider-turn-usage-1",
        },
      });

      const sessionsAfterTurnEnd = yield* adapter.listSessions();
      const currentSession = sessionsAfterTurnEnd.find(
        (session) => session.threadId === "thread-copilot-usage-complete",
      );
      assert.equal(currentSession?.status, "running");
      assert.equal(currentSession?.activeTurnId, turn.turnId);

      fakeClient.session.emit({
        id: "evt-usage",
        type: "assistant.usage",
        timestamp: "2026-03-08T10:00:03.000Z",
        data: {
          promptTokens: 10,
          completionTokens: 12,
          totalTokens: 22,
          model: "gpt-5.4",
        },
      });

      fakeClient.session.emit({
        id: "evt-session-idle-usage",
        type: "session.idle",
        timestamp: "2026-03-08T10:00:04.000Z",
        data: {},
      });

      const events = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(
          Effect.map((chunk): ReadonlyArray<ProviderRuntimeEvent> => Array.from(chunk)),
        ),
      );
      const turnCompletedEvents = events.filter((event) => event.type === "turn.completed");

      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(turnCompletedEvents[0]?.turnId, turn.turnId);
      assert.equal(turnCompletedEvents[0]?.providerRefs?.providerTurnId, "provider-turn-usage-1");
      assert.equal(
        turnCompletedEvents[0]?.type === "turn.completed"
          ? turnCompletedEvents[0].payload.modelUsage?.model
          : undefined,
        "gpt-5.4",
      );
    }),
  );

  it.effect("falls back to session idle to complete a Copilot turn when usage never arrives", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.lastCreateSessionConfig = undefined;
      fakeClient.session.handler = null;

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-idle-complete"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });

      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.asVoid);

      const runtimeEventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, 6),
      ).pipe(Effect.forkChild);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-copilot-idle-complete"),
        input: "wrap up",
      });

      fakeClient.session.emit({
        id: "evt-turn-start-idle",
        type: "assistant.turn_start",
        timestamp: "2026-03-08T10:01:00.000Z",
        data: {
          turnId: "provider-turn-idle-1",
        },
      });

      fakeClient.session.emit({
        id: "evt-assistant-message-idle",
        type: "assistant.message",
        timestamp: "2026-03-08T10:01:01.000Z",
        data: {
          messageId: "msg-idle-1",
          content: "Done",
        },
      });

      fakeClient.session.emit({
        id: "evt-turn-end-idle",
        type: "assistant.turn_end",
        timestamp: "2026-03-08T10:01:02.000Z",
        data: {
          turnId: "provider-turn-idle-1",
        },
      });

      fakeClient.session.emit({
        id: "evt-session-idle",
        type: "session.idle",
        timestamp: "2026-03-08T10:01:03.000Z",
        data: {},
      });

      const events = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(
          Effect.map((chunk): ReadonlyArray<ProviderRuntimeEvent> => Array.from(chunk)),
        ),
      );
      const turnCompletedEvents = events.filter((event) => event.type === "turn.completed");

      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(turnCompletedEvents[0]?.turnId, turn.turnId);
      assert.equal(turnCompletedEvents[0]?.providerRefs?.providerTurnId, "provider-turn-idle-1");
      assert.equal(
        turnCompletedEvents[0]?.type === "turn.completed"
          ? turnCompletedEvents[0].payload.usage
          : undefined,
        undefined,
      );
    }),
  );

  it.effect("emits provider-agnostic user-input question headers", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.lastCreateSessionConfig = undefined;
      fakeClient.session.handler = null;

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-user-input"),
        model: "gpt-5.4",
        runtimeMode: "approval-required",
      });

      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.asVoid);

      const onUserInputRequest = (fakeClient.lastCreateSessionConfig as
        | FakeSessionConfig
        | undefined)?.onUserInputRequest;
      assert.ok(onUserInputRequest);

      const runtimeEventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
        Effect.forkChild,
      );

      const responsePromise = onUserInputRequest({
        question: "Which mode should be used?",
        choices: ["safe", "fast"],
      }) as Promise<unknown>;

      const [event] = Array.from(
        yield* Fiber.join(runtimeEventsFiber).pipe(
          Effect.map((chunk): ReadonlyArray<ProviderRuntimeEvent> => Array.from(chunk)),
        ),
      );

      assert.equal(event?.type, "user-input.requested");
      if (event?.type !== "user-input.requested") {
        return;
      }

      assert.equal(event.payload.questions[0]?.header, "Question");
      assert.equal(event.payload.questions[0]?.question, "Which mode should be used?");
      assert.equal(event.payload.questions[0]?.id, "answer");

      const requestId = event.requestId;
      assert.ok(requestId);
      yield* adapter.respondToUserInput(
        asThreadId("thread-copilot-user-input"),
        ApprovalRequestId.makeUnsafe(requestId),
        {
        answer: "safe",
        },
      );

      const resolved = yield* Effect.promise(() => responsePromise);
      assert.deepStrictEqual(resolved, {
        answer: "safe",
        wasFreeform: false,
      });
    }),
  );

  it.effect("auto-approves Copilot permission requests in full-access mode", () =>
    Effect.gen(function* () {
      fakeClient.connected = false;
      fakeClient.callLog.length = 0;
      fakeClient.lastCreateSessionConfig = undefined;
      fakeClient.session.handler = null;

      const adapter = yield* CopilotAdapter;
      yield* adapter.startSession({
        provider: "copilot",
        threadId: asThreadId("thread-copilot-full-access"),
        model: "gpt-5.4",
        runtimeMode: "full-access",
      });

      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(Effect.asVoid);

      const onPermissionRequest = (fakeClient.lastCreateSessionConfig as
        | FakeSessionConfig
        | undefined)?.onPermissionRequest;
      assert.ok(onPermissionRequest);
      const result = yield* Effect.promise(() =>
        onPermissionRequest({
          kind: "read",
          path: "/Users/zortos/junk/aaa.py",
        } as never) as Promise<unknown>,
      );

      assert.deepStrictEqual(result, { kind: "approved" });
    }),
  );
});
