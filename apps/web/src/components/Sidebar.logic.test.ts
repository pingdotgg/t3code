import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import { resolveThreadStatusPill } from "./Sidebar.logic";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("resolveThreadStatusPill", () => {
  it("returns Pending Approval when an approval request is open", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:00.000Z",
          },
        }),
        { hasPendingApproval: true, hasPendingUserInput: false },
      ),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("returns Pending Approval when a user-input request is open", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:00.000Z",
          },
        }),
        { hasPendingApproval: false, hasPendingUserInput: true },
      ),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("returns Pending Approval when both request types are open", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:00.000Z",
          },
        }),
        { hasPendingApproval: true, hasPendingUserInput: true },
      ),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("returns Working when the session is running without blocking requests", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:00.000Z",
          },
        }),
        { hasPendingApproval: false, hasPendingUserInput: false },
      ),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("returns Connecting when the session is connecting without blocking requests", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          session: {
            provider: "codex",
            status: "connecting",
            orchestrationStatus: "starting",
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:00.000Z",
          },
        }),
        { hasPendingApproval: false, hasPendingUserInput: false },
      ),
    ).toMatchObject({ label: "Connecting", pulse: true });
  });

  it("returns Completed when there is unseen completion and no stronger status", () => {
    expect(
      resolveThreadStatusPill(
        makeThread({
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            requestedAt: "2026-03-09T00:00:00.000Z",
            startedAt: "2026-03-09T00:00:01.000Z",
            completedAt: "2026-03-09T00:00:02.000Z",
            assistantMessageId: null,
          },
          lastVisitedAt: "2026-03-09T00:00:01.500Z",
        }),
        { hasPendingApproval: false, hasPendingUserInput: false },
      ),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("returns null when no status applies", () => {
    expect(
      resolveThreadStatusPill(makeThread(), {
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});
