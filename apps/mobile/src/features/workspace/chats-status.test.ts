import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { createChatsStatusAtom, resolveChatsStatus } from "./chats-status";

const NOW = "2026-11-04T12:00:00.000Z";

function thread(status: "approval" | "input" | "request" | "failed" | "done") {
  const base = makeThreadShellFixture();
  return {
    ...base,
    hasPendingApprovals: status === "approval",
    hasPendingUserInput: status === "input",
    pendingGuestMessageCount: status === "request" ? 1 : 0,
    lastVisitedAt: "2026-11-04T11:00:00.000Z",
    latestRun: {
      runId: RunId.make("run"),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-11-04T11:30:00.000Z",
      assistantMessageId: null,
    },
    runtime: status === "failed" ? runtime("failed") : null,
  };
}

function runtime(status: NonNullable<EnvironmentThreadShell["runtime"]>["status"]) {
  return {
    status,
    activeRunId: null,
    providerInstanceId: makeThreadShellFixture().providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: NOW,
  };
}

describe("Chats status", () => {
  it("uses the highest priority across threads and falls back as requests are handled", () => {
    const threads = [
      thread("done"),
      thread("failed"),
      thread("request"),
      thread("input"),
      thread("approval"),
    ];
    for (const expected of ["approval", "input", "request", "failed", "done"] as const) {
      expect(resolveChatsStatus(threads, NOW)).toBe(expected);
      expect(resolveChatsStatus(threads.toReversed(), NOW)).toBe(expected);
      threads.pop();
    }
    expect(resolveChatsStatus(threads, NOW)).toBeNull();

    const child = { ...thread("done"), pendingSubagentRequest: "approval" as const };
    expect(resolveChatsStatus([child], NOW)).toBe("approval");
    expect(resolveChatsStatus([{ ...child, pendingSubagentRequest: "user_input" }], NOW)).toBe(
      "input",
    );
  });

  it("omits inactive statuses, acknowledged completions, settled threads, and sleeping threads", () => {
    const done = thread("done");
    const base = makeThreadShellFixture();
    const ignored = [
      base,
      { ...done, lastVisitedAt: NOW },
      { ...done, settledOverride: "settled" as const },
      { ...done, snoozedUntil: "2026-11-04T13:00:00.000Z" },
      ...(["preparing", "queued", "starting", "running", "waiting", "idle"] as const).map(
        (status) => ({
          ...done,
          runtime: runtime(status),
        }),
      ),
      {
        ...thread("failed"),
        runtime: { ...runtime("failed"), lastErrorClass: "usage_limit" as const },
      },
    ];
    expect(resolveChatsStatus(ignored, NOW)).toBeNull();
    expect(resolveChatsStatus([{ ...done, snoozedUntil: NOW }], NOW)).toBe("done");
    expect(
      resolveChatsStatus([{ ...thread("input"), snoozedUntil: "2026-11-04T13:00:00.000Z" }], NOW),
    ).toBe("input");
  });

  it("updates while Chats is unmounted without notifying navigation for unrelated changes", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers({ now: new Date(NOW) });
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const done = thread("done");
    const source = Atom.make<ReadonlyArray<EnvironmentThreadShell>>([done]);
    const status = createChatsStatusAtom(source);
    const listener = vi.fn();
    using _subscription = {
      [Symbol.dispose]: registry.subscribe(status, listener, { immediate: true }),
    };
    expect(listener).toHaveBeenLastCalledWith("done");
    registry.set(source, [{ ...done, title: "Renamed", updatedAt: NOW }]);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.set(source, [{ ...done, lastVisitedAt: NOW }]);
    expect(listener).toHaveBeenLastCalledWith(null);
    registry.set(source, [{ ...done, snoozedUntil: "2026-11-04T12:00:01.000Z" }]);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenLastCalledWith("done");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
