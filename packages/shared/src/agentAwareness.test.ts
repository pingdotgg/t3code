import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  type AgentAwarenessThreadShell,
  detailForPhase,
  headlineForNotificationKind,
  headlineForPhase,
  isUserInitiatedTurn,
  projectThreadAwareness,
  resolveThreadAwarenessPhase,
  threadHasPendingApproval,
} from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(overrides: Partial<AgentAwarenessThreadShell> = {}): AgentAwarenessThreadShell {
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

function session(
  overrides: Partial<NonNullable<AgentAwarenessThreadShell["session"]>> = {},
): NonNullable<AgentAwarenessThreadShell["session"]> {
  return {
    threadId: "thread-1" as ThreadId,
    status: "ready",
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function turn(
  overrides: Partial<NonNullable<AgentAwarenessThreadShell["latestTurn"]>> = {},
): NonNullable<AgentAwarenessThreadShell["latestTurn"]> {
  return {
    turnId: "turn-1" as TurnId,
    state: "running",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  };
}

describe("projectThreadAwareness", () => {
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
        session: session({ status: "running", activeTurnId: "turn-1" as TurnId }),
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
        session: session({ status: "running", activeTurnId: "turn-1" as TurnId }),
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
    const finishedTurn = turn({ state: "interrupted", completedAt: NOW });
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
      thread: thread({ session: session({ status: "ready" }) }),
    });

    expect(state?.phase).toBe("completed");
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: session({ status: "error", lastError: "Provider process exited." }),
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});

describe("resolveThreadAwarenessPhase", () => {
  it("returns null for a thread with nothing to report", () => {
    expect(resolveThreadAwarenessPhase(thread())).toBe(null);
  });

  it("reports waiting_for_approval ahead of every other phase", () => {
    expect(
      resolveThreadAwarenessPhase(
        thread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: session({ status: "error", lastError: "boom" }),
          latestTurn: turn({ state: "error" }),
        }),
      ),
    ).toBe("waiting_for_approval");
  });

  // The reason NotificationReactor reads attention from the raw booleans: the
  // phase can only name one of two simultaneous attentions.
  it("swallows pending input behind pending approval", () => {
    expect(
      resolveThreadAwarenessPhase(thread({ hasPendingApprovals: true, hasPendingUserInput: true })),
    ).toBe("waiting_for_approval");
    expect(resolveThreadAwarenessPhase(thread({ hasPendingUserInput: true }))).toBe(
      "waiting_for_input",
    );
  });

  it("reports failed from either the session or the turn", () => {
    expect(resolveThreadAwarenessPhase(thread({ session: session({ status: "error" }) }))).toBe(
      "failed",
    );
    expect(resolveThreadAwarenessPhase(thread({ latestTurn: turn({ state: "error" }) }))).toBe(
      "failed",
    );
  });

  it("reports starting and running from the session status", () => {
    expect(resolveThreadAwarenessPhase(thread({ session: session({ status: "starting" }) }))).toBe(
      "starting",
    );
    expect(resolveThreadAwarenessPhase(thread({ session: session({ status: "running" }) }))).toBe(
      "running",
    );
    expect(resolveThreadAwarenessPhase(thread({ latestTurn: turn({ state: "running" }) }))).toBe(
      "running",
    );
  });

  it("stays silent for a stopped session with no latest turn", () => {
    expect(resolveThreadAwarenessPhase(thread({ session: session({ status: "stopped" }) }))).toBe(
      null,
    );
  });
});

describe("attention and turn provenance", () => {
  it("counts an actionable proposed plan as a pending approval", () => {
    expect(
      threadHasPendingApproval({ hasPendingApprovals: false, hasActionableProposedPlan: false }),
    ).toBe(false);
    expect(
      threadHasPendingApproval({ hasPendingApprovals: true, hasActionableProposedPlan: false }),
    ).toBe(true);
    expect(
      threadHasPendingApproval({ hasPendingApprovals: false, hasActionableProposedPlan: true }),
    ).toBe(true);
  });

  it("cannot classify a thread with no latest turn", () => {
    expect(isUserInitiatedTurn({ latestTurn: null, latestUserMessageAt: NOW })).toBe(null);
  });

  it("treats a turn with no user message at all as background work", () => {
    expect(isUserInitiatedTurn({ latestTurn: turn(), latestUserMessageAt: null })).toBe(false);
  });

  it("treats a user message at or after the turn request as user-initiated", () => {
    expect(isUserInitiatedTurn({ latestTurn: turn(), latestUserMessageAt: NOW })).toBe(true);
    expect(
      isUserInitiatedTurn({
        latestTurn: turn({ requestedAt: NOW }),
        // Steering appends a later user message to a turn already running.
        latestUserMessageAt: "2026-05-22T12:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("treats a turn requested after the last user message as background work", () => {
    expect(
      isUserInitiatedTurn({
        latestTurn: turn({ requestedAt: "2026-05-22T12:00:01.000Z" }),
        latestUserMessageAt: NOW,
      }),
    ).toBe(false);
  });
});

describe("notification copy", () => {
  it("keys notification copy on the kind, not the priority-ordered phase", () => {
    expect(headlineForNotificationKind("turn-completed")).toBe("Agent finished");
    expect(headlineForNotificationKind("turn-failed")).toBe("Agent failed");
    expect(headlineForNotificationKind("approval-required")).toBe("Approval needed");
    expect(headlineForNotificationKind("user-input-required")).toBe("Waiting for input");
  });

  it("names every phase", () => {
    expect(headlineForPhase("starting")).toBe("Starting agent");
    expect(headlineForPhase("running")).toBe("Agent is working");
    expect(headlineForPhase("waiting_for_approval")).toBe("Approval needed");
    expect(headlineForPhase("waiting_for_input")).toBe("Waiting for input");
    expect(headlineForPhase("completed")).toBe("Agent finished");
    expect(headlineForPhase("failed")).toBe("Agent failed");
    expect(headlineForPhase("stale")).toBe("Update delayed");
  });

  it("carries the session error as the failure detail", () => {
    expect(
      detailForPhase("failed", thread({ session: session({ status: "error", lastError: "boom" }) })),
    ).toBe("boom");
    expect(detailForPhase("completed", thread())).toBe("Review the completed task.");
    expect(detailForPhase("running", thread({ session: session({ status: "running" }) }))).toBe(
      "Codex is active.",
    );
    expect(detailForPhase("starting", thread())).toBe(undefined);
  });
});
