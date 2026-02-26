import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSendTurnInput,
  ProviderSessionId,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderThreadId,
  ProviderTurnId,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import { afterAll, assert, it, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Fiber, Stream } from "effect";

import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: ProviderSessionStartInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        sessionId: asSessionId("sess-1"),
        provider: "codex",
        status: "ready",
        threadId: ProviderThreadId.makeUnsafe("thread-1"),
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: ProviderThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_sessionId: ProviderSessionId, _turnId?: ProviderTurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_sessionId: ProviderSessionId) => ({
    threadId: ProviderThreadId.makeUnsafe("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_sessionId: ProviderSessionId, _numTurns: number) => ({
    threadId: ProviderThreadId.makeUnsafe("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _sessionId: ProviderSessionId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override interruptTurn(sessionId: ProviderSessionId, turnId?: ProviderTurnId): Promise<void> {
    return this.interruptTurnImpl(sessionId, turnId);
  }

  override readThread(sessionId: ProviderSessionId) {
    return this.readThreadImpl(sessionId);
  }

  override rollbackThread(sessionId: ProviderSessionId, numTurns: number) {
    return this.rollbackThreadImpl(sessionId, numTurns);
  }

  override respondToRequest(
    sessionId: ProviderSessionId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(sessionId, requestId, decision);
  }

  override stopSession(_sessionId: ProviderSessionId): void {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_sessionId: ProviderSessionId): boolean {
    return false;
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

const validationManager = new FakeCodexManager();
const validationLayer = it.layer(makeCodexAdapterLive({ manager: validationManager }));

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeCode",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeCode'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(makeCodexAdapterLive({ manager: sessionErrorManager }));

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          sessionId: asSessionId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.sessionId, "sess-missing");
      assert.instanceOf(result.failure.cause, Error);
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(makeCodexAdapterLive({ manager: lifecycleManager }));

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical message.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        sessionId: asSessionId("sess-1"),
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: ProviderThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "message.completed");
      if (firstEvent.value.type !== "message.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        sessionId: asSessionId("sess-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.sessionId, "sess-1");
      assert.equal(firstEvent.value.message, "Session stopped");
    }),
  );
});

afterAll(() => {
  assert.equal(lifecycleManager.stopAllImpl.mock.calls.length, 1);
});
