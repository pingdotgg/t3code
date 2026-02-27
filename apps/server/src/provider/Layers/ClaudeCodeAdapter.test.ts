import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { afterAll, assert, it, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Fiber, Queue, Stream } from "effect";

import { ProviderAdapterValidationError } from "../Errors.ts";
import { ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";
import { type ClaudeCodeRuntime, makeClaudeCodeAdapterLive } from "./ClaudeCodeAdapter.ts";

const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);

class FakeClaudeRuntime implements ClaudeCodeRuntime {
  private readonly runtimeEventQueue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  readonly streamEvents = Stream.fromQueue(this.runtimeEventQueue);

  public startSessionImpl = vi.fn(
    async (input: ProviderSessionStartInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        sessionId: asSessionId("claude-sess-1"),
        provider: "claudeCode",
        status: "ready",
        threadId: ProviderThreadId.makeUnsafe("claude-thread-1"),
        resumeCursor: input.resumeCursor ?? { opaque: "claude-cursor-1" },
        cwd: input.cwd,
        model: input.model,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: ProviderThreadId.makeUnsafe("claude-thread-1"),
      turnId: asTurnId("claude-turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_sessionId: ProviderSessionId, _turnId?: ProviderTurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_sessionId: ProviderSessionId) => ({
    threadId: ProviderThreadId.makeUnsafe("claude-thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(
    async (_sessionId: ProviderSessionId, _numTurns: number) => ({
      threadId: ProviderThreadId.makeUnsafe("claude-thread-1"),
      turns: [],
    }),
  );

  public respondToRequestImpl = vi.fn(
    async (
      _sessionId: ProviderSessionId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public stopSessionImpl = vi.fn((_sessionId: ProviderSessionId) => undefined);
  public listSessionsImpl = vi.fn((): ReadonlyArray<ProviderSession> => []);
  public hasSessionImpl = vi.fn((_sessionId: ProviderSessionId): boolean => false);
  public stopAllImpl = vi.fn(() => undefined);

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  async interruptTurn(sessionId: ProviderSessionId, turnId?: ProviderTurnId): Promise<void> {
    return this.interruptTurnImpl(sessionId, turnId);
  }

  async readThread(sessionId: ProviderSessionId) {
    return this.readThreadImpl(sessionId);
  }

  async rollbackThread(sessionId: ProviderSessionId, numTurns: number) {
    return this.rollbackThreadImpl(sessionId, numTurns);
  }

  async respondToRequest(
    sessionId: ProviderSessionId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(sessionId, requestId, decision);
  }

  stopSession(sessionId: ProviderSessionId): void {
    this.stopSessionImpl(sessionId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return this.listSessionsImpl();
  }

  hasSession(sessionId: ProviderSessionId): boolean {
    return this.hasSessionImpl(sessionId);
  }

  stopAll(): void {
    this.stopAllImpl();
  }

  emitRuntimeEvent(event: ProviderRuntimeEvent): void {
    Queue.offerAllUnsafe(this.runtimeEventQueue, [event]);
  }
}

const validationRuntime = new FakeClaudeRuntime();
const validationLayer = it.layer(makeClaudeCodeAdapterLive({ runtime: validationRuntime }));

validationLayer("ClaudeCodeAdapterLive validation", (it) => {
  it.effect("returns validation error for non-claudeCode provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const result = yield* adapter
        .startSession({
          provider: "codex",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderAdapterValidationError({
          provider: "claudeCode",
          operation: "startSession",
          issue: "Expected provider 'claudeCode' but received 'codex'.",
        }),
      );
      assert.equal(validationRuntime.startSessionImpl.mock.calls.length, 0);
    }),
  );
});

const sessionErrorRuntime = new FakeClaudeRuntime();
sessionErrorRuntime.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: claude-sess-missing");
});
const sessionErrorLayer = it.layer(makeClaudeCodeAdapterLive({ runtime: sessionErrorRuntime }));

sessionErrorLayer("ClaudeCodeAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          sessionId: asSessionId("claude-sess-missing"),
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
      assert.equal(result.failure.provider, "claudeCode");
      assert.equal(result.failure.sessionId, "claude-sess-missing");
      assert.instanceOf(result.failure.cause, Error);
    }),
  );
});

const lifecycleRuntime = new FakeClaudeRuntime();
const lifecycleLayer = it.layer(makeClaudeCodeAdapterLive({ runtime: lifecycleRuntime }));

lifecycleLayer("ClaudeCodeAdapterLive lifecycle", (it) => {
  it.effect("forwards providerOptions and opaque resumeCursor to runtime startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const resumeCursor = {
        threadId: "provider-thread-opaque",
        sessionAt: "message:42",
      };
      const started = yield* adapter.startSession({
        provider: "claudeCode",
        cwd: "/tmp/claude-workspace",
        model: "claude-sonnet-4",
        resumeCursor,
        providerOptions: {
          claudeCode: {
            binaryPath: "/usr/local/bin/claude",
            permissionMode: "acceptEdits",
            maxThinkingTokens: 4_096,
          },
        },
      });

      assert.equal(started.provider, "claudeCode");
      assert.deepEqual(started.resumeCursor, resumeCursor);
      assert.deepEqual(lifecycleRuntime.startSessionImpl.mock.calls[0]?.[0], {
        provider: "claudeCode",
        cwd: "/tmp/claude-workspace",
        model: "claude-sonnet-4",
        resumeCursor,
        providerOptions: {
          claudeCode: {
            binaryPath: "/usr/local/bin/claude",
            permissionMode: "acceptEdits",
            maxThinkingTokens: 4_096,
          },
        },
      });
    }),
  );

  it.effect("passes through canonical runtime events without remapping", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeCodeAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const runtimeEvent: ProviderRuntimeEvent = {
        type: "approval.requested",
        eventId: asEventId("evt-claude-approval"),
        provider: "claudeCode",
        sessionId: asSessionId("claude-sess-1"),
        createdAt: new Date().toISOString(),
        requestId: asRequestId("approval-claude-1"),
        requestKind: "command",
      };

      lifecycleRuntime.emitRuntimeEvent(runtimeEvent);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.deepEqual(firstEvent.value, runtimeEvent);
    }),
  );
});

afterAll(() => {
  assert.equal(validationRuntime.stopAllImpl.mock.calls.length, 1);
  assert.equal(sessionErrorRuntime.stopAllImpl.mock.calls.length, 1);
  assert.equal(lifecycleRuntime.stopAllImpl.mock.calls.length, 1);
});
