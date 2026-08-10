import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_COLUMNS,
  isActiveBoardColumn,
  partitionThreadsIntoBoardColumns,
  resolveBoardColumn,
  resolveDropIntent,
  type BoardColumnId,
  type BoardEnvironmentCapabilities,
  type BoardPartitionContext,
} from "./Board.logic";
import type { SidebarThreadSummary } from "../../types";

const NOW = "2026-04-10T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-local");

const ALL_CAPABILITIES: BoardEnvironmentCapabilities = {
  settlement: true,
  snooze: true,
  pinning: true,
};

let threadCounter = 0;

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  threadCounter += 1;
  const threadId = ThreadId.make(`thread-${threadCounter}`);
  return {
    environmentId,
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `Thread ${threadCounter}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as SidebarThreadSummary;
}

function makeSession(
  overrides: Partial<NonNullable<SidebarThreadSummary["session"]>> = {},
): NonNullable<SidebarThreadSummary["session"]> {
  return {
    threadId: ThreadId.make("thread-session"),
    status: "idle",
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  } as NonNullable<SidebarThreadSummary["session"]>;
}

function completedTurn(completedAt: string) {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
    assistantMessageId: null,
  };
}

function makeContext(overrides: Partial<BoardPartitionContext> = {}): BoardPartitionContext {
  return {
    now: NOW,
    preciseNow: NOW,
    autoSettleAfterDays: null,
    capabilitiesFor: () => ALL_CAPABILITIES,
    changeRequestStateFor: () => null,
    lastVisitedAtFor: () => undefined,
    ...overrides,
  };
}

function columnOf(
  thread: SidebarThreadSummary,
  overrides: Partial<BoardPartitionContext> = {},
): BoardColumnId {
  return resolveBoardColumn(thread, makeContext(overrides));
}

describe("BOARD_COLUMNS", () => {
  it("has unique ids and marks exactly the four agent-owned lanes active", () => {
    const ids = BOARD_COLUMNS.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(isActiveBoardColumn)).toEqual(["needs-you", "working", "review", "idle"]);
  });
});

describe("resolveBoardColumn — active split", () => {
  it("puts pending approvals in Needs You", () => {
    expect(columnOf(makeThread({ hasPendingApprovals: true }))).toBe("needs-you");
  });

  it("puts pending user input in Needs You", () => {
    expect(columnOf(makeThread({ hasPendingUserInput: true }))).toBe("needs-you");
  });

  it("puts a failed session in Needs You, not Working", () => {
    expect(columnOf(makeThread({ session: makeSession({ status: "error" }) }))).toBe("needs-you");
  });

  it("keeps a failed session in Needs You even while a background fleet runs", () => {
    const thread = makeThread({
      session: makeSession({ status: "error" }),
      backgroundLiveness: "working",
    });
    expect(columnOf(thread)).toBe("needs-you");
  });

  it("puts a running session in Working", () => {
    expect(columnOf(makeThread({ session: makeSession({ status: "running" }) }))).toBe("working");
  });

  it("puts a starting session in Working", () => {
    expect(columnOf(makeThread({ session: makeSession({ status: "starting" }) }))).toBe("working");
  });

  it("puts a settled turn with a live subagent fleet in Working, not Idle", () => {
    const thread = makeThread({
      session: makeSession({ status: "idle" }),
      backgroundLiveness: "working",
    });
    expect(columnOf(thread)).toBe("working");
  });

  it("puts a monitoring watch loop in Working, not Idle", () => {
    const thread = makeThread({
      session: makeSession({ status: "idle" }),
      backgroundLiveness: "monitoring",
    });
    expect(columnOf(thread)).toBe("working");
  });

  it("puts an actionable plan prompt in Review", () => {
    const thread = makeThread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      session: makeSession({ status: "idle" }),
      latestTurn: completedTurn("2026-04-09T00:00:00.000Z"),
    });
    expect(columnOf(thread)).toBe("review");
  });

  it("ranks an actionable plan prompt above background work", () => {
    const thread = makeThread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      session: makeSession({ status: "idle" }),
      latestTurn: completedTurn("2026-04-09T00:00:00.000Z"),
      backgroundLiveness: "monitoring",
    });
    expect(columnOf(thread)).toBe("review");
  });

  it("puts an unseen completion in Review", () => {
    const thread = makeThread({ latestTurn: completedTurn("2026-04-09T12:00:00.000Z") });
    expect(columnOf(thread, { lastVisitedAtFor: () => "2026-04-09T06:00:00.000Z" })).toBe("review");
  });

  it("puts a completion the user already saw in Idle", () => {
    const thread = makeThread({ latestTurn: completedTurn("2026-04-09T12:00:00.000Z") });
    expect(columnOf(thread, { lastVisitedAtFor: () => "2026-04-09T18:00:00.000Z" })).toBe("idle");
  });

  it("puts a quiet thread with nothing pending in Idle", () => {
    expect(columnOf(makeThread({ session: makeSession({ status: "idle" }) }))).toBe("idle");
  });
});

describe("resolveBoardColumn — lifecycle precedence", () => {
  const snoozed = {
    snoozedUntil: "2026-04-11T00:00:00.000Z",
    snoozedAt: "2026-04-09T00:00:00.000Z",
  };

  it("puts an explicitly settled thread in Done", () => {
    const thread = makeThread({ settledOverride: "settled", settledAt: NOW });
    expect(columnOf(thread)).toBe("done");
  });

  it("puts a snoozed thread in Snoozed", () => {
    expect(columnOf(makeThread(snoozed))).toBe("snoozed");
  });

  it("ranks snooze above a pin", () => {
    const thread = makeThread({ ...snoozed, pinnedAt: NOW });
    expect(columnOf(thread)).toBe("snoozed");
  });

  it("ranks a pin above settled, keeping the thread out of Done", () => {
    const thread = makeThread({ settledOverride: "settled", settledAt: NOW, pinnedAt: NOW });
    expect(columnOf(thread)).toBe("idle");
  });

  it("keeps a pinned thread out of Done when auto-settle would otherwise fire", () => {
    const stale = makeThread({
      pinnedAt: NOW,
      latestTurn: completedTurn("2026-04-01T00:00:00.000Z"),
    });
    expect(columnOf(stale, { autoSettleAfterDays: 3 })).toBe("idle");
  });

  it("auto-settles an unpinned stale thread into Done", () => {
    const stale = makeThread({ latestTurn: completedTurn("2026-04-01T00:00:00.000Z") });
    expect(columnOf(stale, { autoSettleAfterDays: 3 })).toBe("done");
  });

  it("keeps blocked work visible even when explicitly settled", () => {
    const thread = makeThread({
      settledOverride: "settled",
      settledAt: NOW,
      hasPendingApprovals: true,
    });
    expect(columnOf(thread)).toBe("needs-you");
  });

  it("settles a thread whose PR merged", () => {
    const thread = makeThread({ branch: "feature" });
    expect(columnOf(thread, { changeRequestStateFor: () => "merged" })).toBe("done");
  });
});

describe("resolveBoardColumn — capability gating", () => {
  const noSettlement: BoardEnvironmentCapabilities = { ...ALL_CAPABILITIES, settlement: false };
  const noSnooze: BoardEnvironmentCapabilities = { ...ALL_CAPABILITIES, snooze: false };

  it("classifies a settled thread as active when the server cannot settle", () => {
    const thread = makeThread({ settledOverride: "settled", settledAt: NOW });
    expect(columnOf(thread, { capabilitiesFor: () => noSettlement })).toBe("idle");
  });

  it("classifies a snoozed thread as active when the server cannot snooze", () => {
    const thread = makeThread({
      snoozedUntil: "2026-04-11T00:00:00.000Z",
      snoozedAt: "2026-04-09T00:00:00.000Z",
    });
    expect(columnOf(thread, { capabilitiesFor: () => noSnooze })).toBe("idle");
  });
});

describe("partitionThreadsIntoBoardColumns", () => {
  it("drops archived threads from the board entirely", () => {
    const columns = partitionThreadsIntoBoardColumns(
      [makeThread({ archivedAt: NOW }), makeThread({ hasPendingApprovals: true })],
      makeContext(),
    );
    expect(columns["needs-you"]).toHaveLength(1);
    expect(Object.values(columns).flat()).toHaveLength(1);
  });

  it("sorts pinned cards to the top of their column", () => {
    const older = makeThread({ createdAt: "2026-04-01T00:00:00.000Z", pinnedAt: NOW });
    const newer = makeThread({ createdAt: "2026-04-05T00:00:00.000Z" });
    const columns = partitionThreadsIntoBoardColumns([newer, older], makeContext());
    expect(columns.idle.map((thread) => thread.id)).toEqual([older.id, newer.id]);
  });

  it("orders the snoozed shelf by soonest wake", () => {
    const later = makeThread({
      snoozedUntil: "2026-04-12T00:00:00.000Z",
      snoozedAt: "2026-04-09T00:00:00.000Z",
    });
    const sooner = makeThread({
      snoozedUntil: "2026-04-11T00:00:00.000Z",
      snoozedAt: "2026-04-09T00:00:00.000Z",
    });
    const columns = partitionThreadsIntoBoardColumns([later, sooner], makeContext());
    expect(columns.snoozed.map((thread) => thread.id)).toEqual([sooner.id, later.id]);
  });

  it("returns every column even when empty", () => {
    const columns = partitionThreadsIntoBoardColumns([], makeContext());
    for (const column of BOARD_COLUMNS) {
      expect(columns[column.id]).toEqual([]);
    }
  });
});

describe("resolveDropIntent", () => {
  function intent(input: {
    thread?: SidebarThreadSummary;
    from: BoardColumnId;
    to: BoardColumnId;
    capabilities?: BoardEnvironmentCapabilities;
  }) {
    return resolveDropIntent({
      thread: input.thread ?? makeThread(),
      from: input.from,
      to: input.to,
      capabilities: input.capabilities ?? ALL_CAPABILITIES,
      now: NOW,
    });
  }

  it("settles when dropping an active card on Done", () => {
    expect(intent({ from: "idle", to: "done" })).toEqual({ kind: "settle" });
  });

  it("snoozes when dropping an active card on Snoozed", () => {
    expect(intent({ from: "idle", to: "snoozed" })).toEqual({ kind: "snooze" });
  });

  it("unsettles when dropping a Done card on any active column", () => {
    for (const to of ["needs-you", "working", "review", "idle"] as const) {
      expect(intent({ from: "done", to })).toEqual({ kind: "unsettle" });
    }
  });

  it("unsnoozes when dropping a Snoozed card on any active column", () => {
    for (const to of ["needs-you", "working", "review", "idle"] as const) {
      expect(intent({ from: "snoozed", to })).toEqual({ kind: "unsnooze" });
    }
  });

  it("refuses moves between agent-owned columns", () => {
    expect(intent({ from: "working", to: "idle" }).kind).toBe("none");
    expect(intent({ from: "needs-you", to: "review" }).kind).toBe("none");
  });

  it("refuses a drop onto the column the card already sits in", () => {
    expect(intent({ from: "done", to: "done" }).kind).toBe("none");
  });

  it("refuses settling a running thread with a reason", () => {
    const running = makeThread({ session: makeSession({ status: "running" }) });
    const result = intent({ thread: running, from: "working", to: "done" });
    expect(result.kind).toBe("none");
    expect(result.reason).toContain("needs attention");
  });

  it("refuses snoozing a thread that is waiting on the user, with a reason", () => {
    const blocked = makeThread({ hasPendingApprovals: true });
    const result = intent({ thread: blocked, from: "needs-you", to: "snoozed" });
    expect(result.kind).toBe("none");
    expect(result.reason).toContain("waiting on you");
  });

  it("refuses settling when the server lacks the capability", () => {
    const result = intent({
      from: "idle",
      to: "done",
      capabilities: { ...ALL_CAPABILITIES, settlement: false },
    });
    expect(result.kind).toBe("none");
    expect(result.reason).toContain("does not support settling");
  });

  it("refuses snoozing when the server lacks the capability", () => {
    const result = intent({
      from: "idle",
      to: "snoozed",
      capabilities: { ...ALL_CAPABILITIES, snooze: false },
    });
    expect(result.kind).toBe("none");
    expect(result.reason).toContain("does not support snoozing");
  });

  it("still settles a pinned card dropped on Done", () => {
    const pinned = makeThread({ pinnedAt: NOW });
    expect(intent({ thread: pinned, from: "idle", to: "done" })).toEqual({ kind: "settle" });
  });
});
