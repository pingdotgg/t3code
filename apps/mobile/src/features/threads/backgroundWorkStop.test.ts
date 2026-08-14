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
      buildBackgroundWorkInterruptInput({ id: threadId, session }, undefined, "0.0.33"),
    ).toEqual({
      threadId,
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
    const inFlightChanges: boolean[] = [];
    const guard = createBackgroundWorkStopGuard((inFlight) => {
      inFlightChanges.push(inFlight);
    });

    const first = guard.run(interrupt);
    expect(interrupt).toHaveBeenCalledOnce();
    expect(guard.isInFlight()).toBe(true);
    expect(inFlightChanges).toEqual([true]);

    resolveInterrupt?.();
    await expect(first).resolves.toBe(true);
    const second = guard.run(interrupt);
    await expect(second).resolves.toBe(false);
    expect(guard.isInFlight()).toBe(true);
    expect(inFlightChanges).toEqual([true]);

    guard.resolve();
    guard.resolve();
    expect(guard.isInFlight()).toBe(false);
    expect(inFlightChanges).toEqual([true, false]);
  });

  it("re-enables Stop when a legacy server emits no resolution activity", async () => {
    vi.useFakeTimers();
    try {
      const inFlightChanges: boolean[] = [];
      const onTimeout = vi.fn();
      const guard = createBackgroundWorkStopGuard(
        (inFlight) => {
          inFlightChanges.push(inFlight);
        },
        { timeoutMs: 3_000, onTimeout },
      );

      await expect(guard.run(async () => undefined)).resolves.toBe(true);
      expect(guard.isInFlight()).toBe(true);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(guard.isInFlight()).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(guard.isInFlight()).toBe(false);
      expect(inFlightChanges).toEqual([true, false]);
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
      const guard = createBackgroundWorkStopGuard(() => undefined, { timeoutMs: 3_000 });
      const first = guard.run(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(guard.isInFlight()).toBe(false);
      await expect(guard.run(async () => undefined)).resolves.toBe(true);
      expect(guard.isInFlight()).toBe(true);

      rejectFirst?.(new Error("late legacy failure"));
      await expect(first).rejects.toThrow("late legacy failure");
      expect(guard.isInFlight()).toBe(true);
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
      const guard = createBackgroundWorkStopGuard(() => undefined, {
        timeoutMs: 3_000,
        onTimeout,
      });
      const first = guard.run(
        async (attempt) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              attempt.resolve();
              resolve();
            };
          }),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(guard.isInFlight()).toBe(false);
      onTimeout.mockClear();

      await expect(guard.run(async () => undefined)).resolves.toBe(true);
      finishFirst?.();
      await expect(first).resolves.toBe(true);
      expect(guard.isInFlight()).toBe(true);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(guard.isInFlight()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pending timeout when the route cleanup resolves the guard", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const guard = createBackgroundWorkStopGuard(() => undefined, {
        timeoutMs: 3_000,
        onTimeout,
      });

      await expect(guard.run(async () => undefined)).resolves.toBe(true);
      guard.resolve();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(onTimeout).not.toHaveBeenCalled();
      expect(guard.isInFlight()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
