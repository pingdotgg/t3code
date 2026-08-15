import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_STATES,
  boardProjectDimensionKey,
  boardStateDimensionKey,
  boardWorkflowDimensionKey,
  buildBoardRows,
  resolveBoardThreadState,
  type BoardOrganizationEntry,
  type BoardStateId,
} from "./boardOrganization.ts";

function threadShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-08-12T15:00:00.000Z",
      startedAt: "2026-08-12T15:00:01.000Z",
      completedAt: "2026-08-12T15:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-08-12T14:00:00.000Z",
    updatedAt: "2026-08-12T15:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    session: null,
    latestUserMessageAt: "2026-08-12T15:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("resolveBoardThreadState", () => {
  it("lets the board lifecycle projection override runtime presentation", () => {
    const working = threadShell({
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-2"),
        lastError: null,
        updatedAt: "2026-08-12T15:45:00.000Z",
      },
    });

    expect(resolveBoardThreadState(working, "snoozed")).toBe("snoozed");
    expect(resolveBoardThreadState(working, "settled")).toBe("settled");
    expect(resolveBoardThreadState(working, "archived")).toBeNull();
  });

  it("preserves attention precedence from canonical runtime state", () => {
    const thread = threadShell({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-2"),
        lastError: null,
        updatedAt: "2026-08-12T15:45:00.000Z",
      },
    });

    expect(resolveBoardThreadState(thread, "visible")).toBe("approval");
    expect(resolveBoardThreadState({ ...thread, hasPendingApprovals: false }, "visible")).toBe(
      "input",
    );
  });

  it("folds plan-ready into Input and connecting and monitoring into Working", () => {
    expect(
      resolveBoardThreadState(
        threadShell({ interactionMode: "plan", hasActionableProposedPlan: true }),
        "visible",
      ),
    ).toBe("input");
    expect(
      resolveBoardThreadState(
        threadShell({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "starting",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-08-12T15:45:00.000Z",
          },
        }),
        "visible",
      ),
    ).toBe("working");
    expect(
      resolveBoardThreadState(threadShell({ backgroundLiveness: "monitoring" }), "visible"),
    ).toBe("working");
  });

  it("keeps completed resting threads in Idle without read-state input", () => {
    expect(resolveBoardThreadState(threadShell(), "visible")).toBe("idle");
  });
});

interface TestEntry extends BoardOrganizationEntry {
  readonly id: string;
}

function entry(
  id: string,
  projectKey: string,
  projectTitle: string,
  boardStateId: BoardStateId,
): TestEntry {
  return { id, projectKey, projectTitle, boardStateId };
}

const entries = [
  entry("working-zeta", "project:zeta", "Zeta", "working"),
  entry("approval-alpha", "project:alpha", "alpha", "approval"),
  entry("idle-alpha", "project:alpha", "alpha", "idle"),
] as const;

describe("board dimension keys", () => {
  it("qualifies otherwise identical values by their dimension", () => {
    expect(
      new Set([
        boardWorkflowDimensionKey("working"),
        boardStateDimensionKey("working"),
        boardProjectDimensionKey("working"),
      ]).size,
    ).toBe(3);
  });
});

describe("buildBoardRows", () => {
  it("groups state rows in canonical state order instead of arrival order", () => {
    expect(buildBoardRows(entries, "state", null).map((row) => row.value)).toEqual([
      "draft",
      "approval",
      "input",
      "failed",
      "working",
      "idle",
      "snoozed",
      "settled",
    ]);
    expect(BOARD_STATES.map((state) => state.id)).toEqual([
      "draft",
      "approval",
      "input",
      "failed",
      "working",
      "idle",
      "snoozed",
      "settled",
    ]);
  });

  it("groups project rows by title and retains entry order inside each row", () => {
    const rows = buildBoardRows(entries, "project", null);
    expect(rows.map((row) => row.value)).toEqual(["project:alpha", "project:zeta"]);
    expect(rows[0]?.entries.map((rowEntry) => rowEntry.id)).toEqual([
      "approval-alpha",
      "idle-alpha",
    ]);
  });

  it("applies project scope before state and ungrouped rows", () => {
    const stateRows = buildBoardRows(entries, "state", "project:alpha");
    expect(stateRows.map((row) => row.value)).toEqual(BOARD_STATES.map((state) => state.id));
    expect(
      stateRows.every((row) => row.entries.every((value) => value.projectKey === "project:alpha")),
    ).toBe(true);

    const [ungrouped] = buildBoardRows(entries, "none", "project:zeta");
    expect(ungrouped?.entryCount).toBe(1);
    expect(ungrouped?.entries[0]?.id).toBe("working-zeta");
  });
});
