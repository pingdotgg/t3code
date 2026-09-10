import type { ProviderSession, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  evaluateTurnStartLimits,
  evaluateHandoverStartLimits,
  MAX_CONCURRENT_PROVIDER_TURNS,
} from "./ConcurrentTurnPolicy.ts";

const threadId = "thread-limited" as ThreadId;

function session(index: number, status: ProviderSession["status"] = "running"): ProviderSession {
  return {
    threadId: `thread-${index}` as ThreadId,
    status,
  } as ProviderSession;
}

describe("evaluateTurnStartLimits", () => {
  it("allows handover generation at the context ceiling", () => {
    expect(evaluateHandoverStartLimits({ sessions: [] })).toBeUndefined();
  });

  it("counts each active thread once across sessions and reservations", () => {
    const violation = evaluateTurnStartLimits({
      threadId: "new-thread" as ThreadId,
      sessions: [session(1), session(1), session(2)],
      reservedTurnThreadIds: ["thread-1" as ThreadId, "thread-3" as ThreadId],
    });

    expect(violation).toBeUndefined();
  });

  it("blocks a new turn when the global concurrency ceiling is full", () => {
    const violation = evaluateTurnStartLimits({
      threadId,
      sessions: Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS }, (_, index) => session(index)),
    });

    expect(violation?.code).toBe("concurrent-turn-limit");
  });

  it("counts a turn reservation before the provider reports it as running", () => {
    const violation = evaluateTurnStartLimits({
      threadId,
      sessions: Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) =>
        session(index),
      ),
      reservedTurnThreadIds: ["reserved-thread" as ThreadId],
    });

    expect(violation?.code).toBe("concurrent-turn-limit");
  });

  it("counts handover reservations against the shared provider-work ceiling", () => {
    const violation = evaluateTurnStartLimits({
      threadId,
      sessions: Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS - 1 }, (_, index) =>
        session(index),
      ),
      reservedHandoverCount: 1,
    });

    expect(violation?.code).toBe("concurrent-turn-limit");
  });

  it("does not count ready sessions and permits an already-running thread", () => {
    const sessions = [
      ...Array.from({ length: MAX_CONCURRENT_PROVIDER_TURNS }, (_, index) => session(index)),
      { ...session(99), threadId, status: "running" as const },
      session(100, "ready"),
    ];

    expect(evaluateTurnStartLimits({ threadId, sessions })).toBeUndefined();
  });
});
