import assert from "node:assert/strict";

import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { it, vi } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { KiloServerManager } from "../../kiloServerManager.ts";
import { KiloAdapter } from "../Services/KiloAdapter.ts";
import { makeKiloAdapterLive } from "./KiloAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): RuntimeItemId => RuntimeItemId.makeUnsafe(value);

class FakeKiloManager extends KiloServerManager {
  public startSessionImpl = vi.fn(async (threadId: ThreadId): Promise<ProviderSession> => {
    const now = new Date().toISOString();
    return {
      provider: "kilo",
      status: "ready",
      runtimeMode: "full-access",
      threadId,
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now,
      resumeCursor: { sessionId: `session-${threadId}` },
    } as unknown as ProviderSession;
  });

  public sendTurnImpl = vi.fn(async (threadId: ThreadId): Promise<ProviderTurnStartResult> => ({
    threadId,
    turnId: asTurnId(`turn-${threadId}`),
  }));

  public interruptTurnImpl = vi.fn(async (): Promise<void> => undefined);
  public respondToRequestImpl = vi.fn(async (): Promise<void> => undefined);
  public respondToUserInputImpl = vi.fn(async (): Promise<void> => undefined);
  public readThreadImpl = vi.fn(async (threadId: ThreadId) => ({ threadId, turns: [] }));
  public rollbackThreadImpl = vi.fn(async (threadId: ThreadId) => ({ threadId, turns: [] }));
  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: { threadId: ThreadId }): Promise<ProviderSession> {
    return this.startSessionImpl(input.threadId);
  }

  override sendTurn(input: { threadId: ThreadId }): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input.threadId);
  }

  override interruptTurn(_threadId: ThreadId): Promise<void> {
    return this.interruptTurnImpl();
  }

  override respondToRequest(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl();
  }

  override respondToUserInput(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl();
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId) {
    return this.rollbackThreadImpl(threadId);
  }

  override stopSession(_threadId: ThreadId): void {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

const manager = new FakeKiloManager();
const layer = it.layer(makeKiloAdapterLive({ manager }));

layer("KiloAdapterLive", (it) => {
  it.effect("delegates session startup to the manager", () =>
    Effect.gen(function* () {
      manager.startSessionImpl.mockClear();
      const adapter = yield* KiloAdapter;

      const session = yield* adapter.startSession({
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "kilo");
      assert.equal(manager.startSessionImpl.mock.calls[0]?.[0], asThreadId("thread-1"));
    }),
  );

  it.effect("rejects attachments until Kilo attachment wiring exists", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-attachments"),
          input: "hello",
          attachments: [{ id: "attachment-1" }] as never,
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("forwards manager runtime events through the adapter stream", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event = {
        type: "content.delta",
        eventId: asEventId("evt-kilo-delta"),
        provider: "kilo",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("item-1"),
        payload: {
          streamKind: "assistant_text",
          delta: "hello",
        },
      } as unknown as ProviderRuntimeEvent;

      manager.emit("event", event);
      const received = yield* Fiber.join(eventFiber);

      assert.equal(received._tag, "Some");
      if (received._tag !== "Some") {
        return;
      }
      assert.equal(received.value.type, "content.delta");
      if (received.value.type !== "content.delta") {
        return;
      }
      assert.equal(received.value.payload.delta, "hello");
    }),
  );
});
