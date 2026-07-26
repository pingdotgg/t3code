import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    autoReviewPhase: null,
    ...overrides,
  };
}

describe("resolveThreadStatus settled indicator", () => {
  it("shows a neutral Settled pill for a settled thread", () => {
    const status = resolveThreadStatus(
      makeThread("settled", {
        settledOverride: "settled",
        settledAt: "2026-06-02T00:00:00.000Z",
      }),
    );

    expect(status?.kind).toBe("settled");
    expect(status?.label).toBe("Settled");
    expect(status?.pulse).toBe(false);
  });

  it("shows no status for an active quiescent thread", () => {
    expect(resolveThreadStatus(makeThread("active"))).toBeNull();
    expect(
      resolveThreadStatus(
        makeThread("pinned-active", {
          settledOverride: "active",
          latestUserMessageAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("lets actionable and live states outrank the settled badge", () => {
    const pending = resolveThreadStatus(
      makeThread("pending", {
        settledOverride: "settled",
        settledAt: "2026-06-02T00:00:00.000Z",
        hasPendingApprovals: true,
      }),
    );
    expect(pending?.kind).toBe("pending-approval");

    const running = resolveThreadStatus(
      makeThread("running", {
        settledOverride: "settled",
        settledAt: "2026-06-02T00:00:00.000Z",
        session: {
          threadId: ThreadId.make("running"),
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      }),
    );
    expect(running?.kind).toBe("working");
  });
});

describe("resolveThreadStatus latestTurn fallback", () => {
  const runningTurn = {
    turnId: TurnId.make("turn-1"),
    state: "running" as const,
    requestedAt: "2026-06-02T00:00:00.000Z",
    startedAt: "2026-06-02T00:00:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  };

  it("shows Working when the latest turn is running but the session status is quiescent", () => {
    const status = resolveThreadStatus(
      makeThread("live-turn", {
        latestTurn: runningTurn,
        session: {
          threadId: ThreadId.make("live-turn"),
          status: "ready",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      }),
    );

    expect(status?.kind).toBe("working");
    expect(status?.label).toBe("Working");
    expect(status?.pulse).toBe(true);
  });

  it("keeps error precedence over a running latest turn", () => {
    const status = resolveThreadStatus(
      makeThread("error-turn", {
        latestTurn: runningTurn,
        session: {
          threadId: ThreadId.make("error-turn"),
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "boom",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      }),
    );

    expect(status?.kind).toBe("error");
  });
});

describe("resolveThreadStatus auto-review phases", () => {
  const runningSession = (id: string) => ({
    threadId: ThreadId.make(id),
    status: "running" as const,
    providerName: "Codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-06-02T00:00:00.000Z",
  });

  const completedTurn = {
    turnId: TurnId.make("turn-done"),
    state: "completed" as const,
    requestedAt: "2026-06-02T00:00:00.000Z",
    startedAt: "2026-06-02T00:00:01.000Z",
    completedAt: "2026-06-02T00:01:00.000Z",
    assistantMessageId: null,
  };

  it("shows Fixing while a fix is being applied, outranking a running session", () => {
    const status = resolveThreadStatus(
      makeThread("fixing", {
        autoReviewPhase: "fixing",
        session: runningSession("fixing"),
      }),
    );

    expect(status?.kind).toBe("fixing");
    expect(status?.label).toBe("Fixing");
    expect(status?.pulse).toBe(true);
  });

  it("shows Reviewing while a review is running, outranking a running session", () => {
    const status = resolveThreadStatus(
      makeThread("reviewing", {
        autoReviewPhase: "reviewing",
        session: runningSession("reviewing"),
      }),
    );

    expect(status?.kind).toBe("reviewing");
    expect(status?.label).toBe("Reviewing");
    expect(status?.pulse).toBe(true);
  });

  it("keeps actionable states above auto-review phases", () => {
    const pending = resolveThreadStatus(
      makeThread("fixing-pending", {
        autoReviewPhase: "fixing",
        hasPendingApprovals: true,
      }),
    );
    expect(pending?.kind).toBe("pending-approval");

    const stalled = resolveThreadStatus(
      makeThread("reviewing-stalled", { autoReviewPhase: "reviewing" }),
      { stalled: true, lastActivityAt: new Date("2026-06-02T00:00:00.000Z"), stalledSince: null },
    );
    expect(stalled?.kind).toBe("stalled");
  });

  it("shows Ready to Merge only when the thread is not busy", () => {
    const busy = resolveThreadStatus(
      makeThread("merge-busy", {
        autoReviewPhase: "readyToMerge",
        session: runningSession("merge-busy"),
      }),
    );
    expect(busy?.kind).toBe("working");

    const ready = resolveThreadStatus(
      makeThread("merge-ready", {
        autoReviewPhase: "readyToMerge",
        latestTurn: completedTurn,
      }),
    );
    expect(ready?.kind).toBe("ready-to-merge");
    expect(ready?.label).toBe("Ready to Merge");
    expect(ready?.pulse).toBe(false);
  });

  it("shows Done only for a completed latest turn", () => {
    const done = resolveThreadStatus(makeThread("done", { latestTurn: completedTurn }));
    expect(done?.kind).toBe("done");
    expect(done?.label).toBe("Done");
    expect(done?.pulse).toBe(false);

    expect(resolveThreadStatus(makeThread("no-turn"))).toBeNull();
  });

  it("keeps Plan Ready above Done for a settled plan turn", () => {
    const status = resolveThreadStatus(
      makeThread("plan-done", {
        interactionMode: "plan",
        latestTurn: completedTurn,
        hasActionableProposedPlan: true,
      }),
    );

    expect(status?.kind).toBe("plan-ready");
  });
});
