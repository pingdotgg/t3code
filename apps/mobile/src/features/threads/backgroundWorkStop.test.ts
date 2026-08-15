import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  backgroundWorkStopConfirmation,
  buildBackgroundWorkInterruptInput,
  createBackgroundWorkStopGuard,
  findBackgroundWorkStopResolution,
} from "./backgroundWorkStop";

function createStopGuardState(options?: Parameters<typeof createBackgroundWorkStopGuard>[1]) {
  let pending: CommandId | null = null;
  const changes: Array<CommandId | null> = [];
  const guard = createBackgroundWorkStopGuard((commandId) => {
    pending = commandId;
    changes.push(commandId);
  }, options);
  let commandSequence = 0;
  const run = (interrupt: Parameters<typeof guard.run>[1]) =>
    guard.run(CommandId.make(`stop-command-${++commandSequence}`), interrupt);
  return { guard, run, changes, pending: () => pending };
}

describe("backgroundWorkStopConfirmation", () => {
  it("dispatches only after the destructive confirmation", () => {
    const stop = vi.fn();
    const confirmation = backgroundWorkStopConfirmation(stop);

    confirmation.actions[0]?.onPress?.();
    expect(stop).not.toHaveBeenCalled();

    confirmation.actions[1]?.onPress?.();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("sends legacy unguarded interrupts to servers before conditional Stop support", () => {
    const threadId = ThreadId.make("thread-background");
    const activeTurnId = TurnId.make("turn-running");
    const commandId = CommandId.make("stop-command");
    const session = {
      threadId,
      status: "ready" as const,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-14T12:00:00.000Z",
    };

    expect(
      buildBackgroundWorkInterruptInput(
        {
          id: threadId,
          session: { ...session, status: "running", activeTurnId },
        },
        commandId,
        "0.0.32",
      ),
    ).toEqual({
      threadId,
      commandId,
      turnId: activeTurnId,
    });
  });

  it("keeps guarded interrupts unchanged for servers with conditional Stop support", () => {
    const threadId = ThreadId.make("thread-background");
    const activeTurnId = TurnId.make("turn-running");
    const commandId = CommandId.make("stop-command");
    const session = {
      threadId,
      status: "ready" as const,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-14T12:00:00.000Z",
    };

    expect(
      buildBackgroundWorkInterruptInput({ id: threadId, session }, commandId, "0.0.33"),
    ).toEqual({
      threadId,
      commandId,
      expectedTurnId: null,
      expectedSessionUpdatedAt: session.updatedAt,
    });
    expect(
      buildBackgroundWorkInterruptInput(
        {
          id: threadId,
          session: { ...session, status: "running", activeTurnId },
        },
        commandId,
        "0.0.33",
      ),
    ).toEqual({
      threadId,
      commandId,
      turnId: activeTurnId,
      expectedTurnId: activeTurnId,
      expectedSessionUpdatedAt: session.updatedAt,
    });
  });

  it("rejects a guarded Stop while the observed session is still starting", () => {
    const threadId = ThreadId.make("thread-background");
    const commandId = CommandId.make("stop-command");
    const session = {
      threadId,
      status: "starting" as const,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-14T12:00:00.000Z",
    };

    expect(
      buildBackgroundWorkInterruptInput({ id: threadId, session }, commandId, "0.0.33"),
    ).toBeNull();
    expect(
      buildBackgroundWorkInterruptInput({ id: threadId, session }, commandId, "0.0.32"),
    ).toEqual({ threadId, commandId });
  });

  it("guards a null-session snapshot on servers with conditional Stop support", () => {
    const threadId = ThreadId.make("thread-background");
    const commandId = CommandId.make("stop-command");

    expect(
      buildBackgroundWorkInterruptInput({ id: threadId, session: null }, commandId, "0.0.33"),
    ).toEqual({
      threadId,
      commandId,
      expectedTurnId: null,
    });
  });

  it("surfaces only the correlated reactor outcome", () => {
    const commandId = CommandId.make("stop-command");
    const activity = (
      requestId: string,
      outcome: "interrupted" | "work-changed" | "no-session",
    ): OrchestrationThreadActivity => ({
      id: EventId.make(`event-${requestId}`),
      kind: "provider.turn.interrupt.resolved",
      tone: "info",
      summary: "Stop request resolved",
      payload: { requestId, outcome, timelineBypass: true },
      turnId: TurnId.make("turn-new"),
      createdAt: "2026-08-14T12:00:01.000Z",
    });

    expect(
      findBackgroundWorkStopResolution([activity("another-command", "work-changed")], commandId),
    ).toBeNull();
    expect(
      findBackgroundWorkStopResolution([activity(commandId, "work-changed")], commandId),
    ).toEqual({
      outcome: "work-changed",
      alert: {
        title: "Work already changed",
        message: "A newer turn or provider session is active, so it was left running.",
      },
    });
    expect(
      findBackgroundWorkStopResolution([activity(commandId, "interrupted")], commandId),
    ).toEqual({
      outcome: "interrupted",
      alert: null,
    });
    expect(
      findBackgroundWorkStopResolution([activity(commandId, "no-session")], commandId),
    ).toEqual({
      outcome: "no-session",
      alert: {
        title: "Stop status unknown",
        message: "No provider session was available when Stop was handled. Check the thread state.",
      },
    });
  });

  it("deduplicates Stop through reactor resolution, not only command acknowledgement", async () => {
    let resolveInterrupt: (() => void) | undefined;
    const interrupt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInterrupt = resolve;
        }),
    );
    const state = createStopGuardState();
    const { guard } = state;

    const first = state.run(interrupt);
    expect(interrupt).toHaveBeenCalledOnce();
    const firstCommandId = state.pending();
    expect(firstCommandId).not.toBeNull();
    expect(state.changes).toEqual([firstCommandId]);

    resolveInterrupt?.();
    await expect(first).resolves.toBe(true);
    const second = state.run(interrupt);
    await expect(second).resolves.toBe(false);
    expect(state.pending()).toBe(firstCommandId);
    expect(state.changes).toEqual([firstCommandId]);

    guard.resolve();
    guard.resolve();
    expect(state.pending()).toBeNull();
    expect(state.changes).toEqual([firstCommandId, null]);
  });

  it("re-enables Stop when a legacy server emits no resolution activity", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const state = createStopGuardState({ timeoutMs: 3_000, onTimeout });

      await expect(state.run(async () => undefined)).resolves.toBe(true);
      const commandId = state.pending();
      expect(commandId).not.toBeNull();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(state.pending()).toBe(commandId);

      await vi.advanceTimersByTimeAsync(1);
      expect(state.pending()).toBeNull();
      expect(state.changes).toEqual([commandId, null]);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(onTimeout).toHaveBeenCalledWith({
        title: "Stop status unknown",
        message:
          "This server did not confirm whether background work stopped. Check the thread before trying again.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a timed-out request clear a newer Stop attempt", async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst: ((error: Error) => void) | undefined;
      const state = createStopGuardState({ timeoutMs: 3_000 });
      const { guard } = state;
      const first = state.run(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(state.pending()).toBeNull();
      await expect(state.run(async () => undefined)).resolves.toBe(true);
      const newerCommandId = state.pending();
      expect(newerCommandId).not.toBeNull();

      rejectFirst?.(new Error("late legacy failure"));
      await expect(first).rejects.toThrow("late legacy failure");
      expect(state.pending()).toBe(newerCommandId);
      guard.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer Stop pending when an older command failure resolves late", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst: (() => void) | undefined;
      const onTimeout = vi.fn();
      const state = createStopGuardState({
        timeoutMs: 3_000,
        onTimeout,
      });
      const first = state.run(
        async (attempt) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              attempt.resolve();
              resolve();
            };
          }),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(state.pending()).toBeNull();
      onTimeout.mockClear();

      await expect(state.run(async () => undefined)).resolves.toBe(true);
      finishFirst?.();
      await expect(first).resolves.toBe(true);
      expect(state.pending()).not.toBeNull();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(state.pending()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Stop pending while the route stays mounted and cancels it on unmount", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const state = createStopGuardState({
        timeoutMs: 3_000,
        onTimeout,
      });
      const { guard } = state;

      await expect(state.run(async () => undefined)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(2_999);

      expect(state.pending()).not.toBeNull();
      expect(onTimeout).not.toHaveBeenCalled();

      // Nested routes blur this screen without running its unmount cleanup.
      guard.resolve();
      await vi.advanceTimersByTimeAsync(1);

      expect(onTimeout).not.toHaveBeenCalled();
      expect(state.pending()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
