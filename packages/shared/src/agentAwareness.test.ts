import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import { projectThreadAwareness } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "goal"
> {
  return {
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("projectThreadAwareness", () => {
  const goal = {
    objective: "Finish the change",
    status: "active" as const,
    createdAt: NOW,
    updatedAt: NOW,
    timeUsedSeconds: 30,
    tokensUsed: 1000,
    tokenBudget: null,
  };
  const completedTurn = {
    turnId: "turn-1" as TurnId,
    state: "completed" as const,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: null,
  };

  it.each([
    ["active", "running", "Goal is running"],
    ["paused", "stale", "Goal paused"],
    ["complete", "completed", "Goal completed"],
    ["blocked", "waiting_for_input", "Goal blocked"],
    ["budgetLimited", "waiting_for_input", "Goal budget reached"],
    ["usageLimited", "waiting_for_input", "Goal usage limit reached"],
  ] as const)("projects native %s goals over settled rounds", (status, phase, headline) => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread({ goal: { ...goal, status }, latestTurn: completedTurn }),
      }),
    ).toMatchObject({ phase, headline });
  });

  it.each([
    [{ hasPendingApprovals: true }, "waiting_for_approval", "Approval needed"],
    [{ hasPendingUserInput: true }, "waiting_for_input", "Waiting for input"],
    [{ latestTurn: { ...completedTurn, state: "error" } }, "failed", "Agent failed"],
  ] as const)("preserves attention and error priority for goals", (overrides, phase, headline) => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread({ goal, ...overrides }),
      }),
    ).toMatchObject({ phase, headline });
  });

  it("keeps a retained completed goal from masking later manual turns", () => {
    for (const state of ["running", "completed"] as const) {
      expect(
        projectThreadAwareness({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: thread({
            goal: { ...goal, status: "complete" },
            latestTurn: { ...completedTurn, requestedAt: "2026-05-22T12:01:00.000Z", state },
          }),
        }),
      ).toMatchObject({
        phase: state,
        headline: state === "running" ? "Agent is working" : "Agent finished",
      });
    }
  });

  it("uses native goal completion time despite later session updates", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread({
          goal: { ...goal, status: "complete" },
          updatedAt: "2026-05-22T12:10:00.000Z",
        }),
      }),
    ).toMatchObject({ updatedAt: NOW });
  });

  it("returns null for idle threads without an active awareness state", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread(),
      }),
    ).toBeNull();
  });

  it("prioritizes approval requests over running state", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        hasPendingApprovals: true,
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
  });

  it("projects running provider sessions", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "running",
      headline: "Agent is working",
      detail: "Codex is active.",
      modelTitle: "gpt-5.4",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("projects completed turns as completed even when teardown settled them as interrupted", () => {
    const finishedTurn = {
      turnId: "turn-1" as TurnId,
      state: "interrupted" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    };
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: finishedTurn }),
    });

    // Session teardown settles still-running turns by session status, and
    // that write can race turn.completed; the completion timestamp is the
    // durable signal. Without this the thread resolves to null persistently
    // and gets tombstoned off the lock-screen card instead of showing Done.
    expect(state?.phase).toBe("completed");

    const trulyInterrupted = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: { ...finishedTurn, completedAt: null } }),
    });
    expect(trulyInterrupted).toBeNull();
  });

  it("projects ready sessions with no materialized turn as completed", () => {
    // Quick threads without code changes never get a checkpoint, so the SQL
    // shell has no latestTurn row and latest_turn_id is cleared when the
    // session settles; the ready session is the only completion signal left.
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "ready",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("completed");
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Provider process exited.",
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});
