import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  FOCUS_MODE_GRACE_MS,
  deriveFocusThreadVisibility,
  resolveFocusProjectExpanded,
} from "./sidebarFocusMode";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("deriveFocusThreadVisibility", () => {
  it("shows a running thread", () => {
    const thread = makeThread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:01:00.000Z",
      },
    });

    expect(
      deriveFocusThreadVisibility({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:01:30.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: true,
      isVisible: true,
    });
  });

  it("shows a thread with pending approval", () => {
    expect(
      deriveFocusThreadVisibility({
        thread: makeThread(),
        hasPendingApprovals: true,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:00:00.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: true,
      isVisible: true,
    });
  });

  it("keeps a recently completed thread visible during the grace window", () => {
    const thread = makeThread({
      lastVisitedAt: "2026-03-09T12:12:00.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-done"),
        state: "completed",
        requestedAt: "2026-03-09T12:00:00.000Z",
        startedAt: "2026-03-09T12:00:02.000Z",
        completedAt: "2026-03-09T12:10:00.000Z",
        assistantMessageId: null,
      },
    });

    expect(
      deriveFocusThreadVisibility({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:11:00.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: false,
      isVisible: true,
      graceExpiresAt: Date.parse("2026-03-09T12:12:00.000Z"),
    });
  });

  it("hides a completed thread after the grace window expires", () => {
    const thread = makeThread({
      lastVisitedAt: "2026-03-09T12:12:00.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-done"),
        state: "completed",
        requestedAt: "2026-03-09T12:00:00.000Z",
        startedAt: "2026-03-09T12:00:02.000Z",
        completedAt: "2026-03-09T12:10:00.000Z",
        assistantMessageId: null,
      },
    });

    expect(
      deriveFocusThreadVisibility({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:12:01.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: false,
      isVisible: false,
    });
  });

  it("treats a settled plan thread as focus-visible", () => {
    const thread = makeThread({
      interactionMode: "plan",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-plan"),
        state: "completed",
        requestedAt: "2026-03-09T12:00:00.000Z",
        startedAt: "2026-03-09T12:00:02.000Z",
        completedAt: "2026-03-09T12:10:00.000Z",
        assistantMessageId: null,
      },
      proposedPlans: [
        {
          id: "plan-1" as Thread["proposedPlans"][number]["id"],
          turnId: TurnId.makeUnsafe("turn-plan"),
          planMarkdown: "# Latest plan",
          createdAt: "2026-03-09T12:09:00.000Z",
          updatedAt: "2026-03-09T12:10:00.000Z",
        },
      ],
      session: {
        provider: "codex",
        status: "ready",
        orchestrationStatus: "ready",
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:10:00.000Z",
      },
    });

    expect(
      deriveFocusThreadVisibility({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:10:30.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: true,
      isVisible: true,
    });
  });

  it("treats errored threads as focus-visible", () => {
    const thread = makeThread({
      lastVisitedAt: "2026-03-09T12:05:00.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-error"),
        state: "error",
        requestedAt: "2026-03-09T12:00:00.000Z",
        startedAt: "2026-03-09T12:00:02.000Z",
        completedAt: "2026-03-09T12:10:00.000Z",
        assistantMessageId: null,
      },
    });

    expect(
      deriveFocusThreadVisibility({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInputs: false,
        now: Date.parse("2026-03-09T12:10:30.000Z"),
        graceMs: FOCUS_MODE_GRACE_MS,
      }),
    ).toMatchObject({
      hasCurrentStatus: true,
      isVisible: true,
    });
  });
});

describe("resolveFocusProjectExpanded", () => {
  it("auto-reveals a project with visible focus work", () => {
    expect(
      resolveFocusProjectExpanded({
        isFocusMode: true,
        baseExpanded: false,
        containsVisibleThread: true,
        manuallyCollapsed: false,
        activeVisibleThreadInContainer: false,
      }),
    ).toBe(true);
  });

  it("lets a manual collapse win for non-active work", () => {
    expect(
      resolveFocusProjectExpanded({
        isFocusMode: true,
        baseExpanded: true,
        containsVisibleThread: true,
        manuallyCollapsed: true,
        activeVisibleThreadInContainer: false,
      }),
    ).toBe(false);
  });

  it("reopens the active project even after a manual collapse", () => {
    expect(
      resolveFocusProjectExpanded({
        isFocusMode: true,
        baseExpanded: true,
        containsVisibleThread: true,
        manuallyCollapsed: true,
        activeVisibleThreadInContainer: true,
      }),
    ).toBe(true);
  });
});
