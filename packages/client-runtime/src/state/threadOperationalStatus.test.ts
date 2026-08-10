import { ThreadId, TurnId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  resolveThreadOperationalStatus,
  type ThreadOperationalStatusInput,
} from "./threadOperationalStatus.ts";

const NOW = "2026-08-10T10:00:00.000Z";

function input(
  overrides: Partial<ThreadOperationalStatusInput> = {},
): ThreadOperationalStatusInput {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function session(status: NonNullable<OrchestrationThreadShell["session"]>["status"]) {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access" as const,
    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
    lastError: status === "error" ? "Provider failed" : null,
    updatedAt: NOW,
  };
}

function latestTurn(state: NonNullable<OrchestrationThreadShell["latestTurn"]>["state"]) {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : NOW,
    assistantMessageId: null,
  };
}

describe("resolveThreadOperationalStatus", () => {
  it("uses the canonical priority order", () => {
    const fullyActionable = input({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: session("running"),
      latestTurn: latestTurn("error"),
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      backgroundLiveness: "working",
    });

    expect(resolveThreadOperationalStatus(fullyActionable)).toBe("needs-approval");
    expect(resolveThreadOperationalStatus({ ...fullyActionable, hasPendingApprovals: false })).toBe(
      "needs-input",
    );
    expect(
      resolveThreadOperationalStatus({
        ...fullyActionable,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        session: session("starting"),
      }),
    ).toBe("connecting");
    expect(
      resolveThreadOperationalStatus({
        ...fullyActionable,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBe("working");
  });

  it("reports session and latest-turn failures before background liveness", () => {
    expect(
      resolveThreadOperationalStatus(
        input({ session: session("error"), backgroundLiveness: "working" }),
      ),
    ).toBe("failed");
    expect(
      resolveThreadOperationalStatus(
        input({ latestTurn: latestTurn("error"), backgroundLiveness: "monitoring" }),
      ),
    ).toBe("failed");
  });

  it.each(["completed", "interrupted"] as const)(
    "matches web/mobile plan-ready behavior for timestamp-settled %s turns",
    (state) => {
      const plan = input({
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        latestTurn: latestTurn(state),
        session: session("ready"),
      });

      expect(resolveThreadOperationalStatus(plan)).toBe("plan-ready");
      expect(resolveThreadOperationalStatus({ ...plan, interactionMode: "default" })).toBe("ready");
    },
  );

  it("does not report plan-ready before the turn has timestamp-settled", () => {
    const runningTurn = latestTurn("running");
    expect(
      resolveThreadOperationalStatus(
        input({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: runningTurn,
        }),
      ),
    ).toBe("ready");
  });

  it("keeps plan-ready ahead of lingering background work", () => {
    expect(
      resolveThreadOperationalStatus(
        input({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: latestTurn("completed"),
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("plan-ready");
  });

  it("distinguishes working, monitoring, and quiescent legacy shells", () => {
    expect(resolveThreadOperationalStatus(input({ backgroundLiveness: "working" }))).toBe(
      "working",
    );
    expect(resolveThreadOperationalStatus(input({ backgroundLiveness: "monitoring" }))).toBe(
      "monitoring",
    );
    expect(resolveThreadOperationalStatus(input())).toBe("ready");
  });
});
