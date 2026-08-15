import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import type { BoardLane } from "../../board/boardLaneStore.ts";
import {
  boardLaneGridTemplateColumns,
  buildProjectSwimlanes,
  boardLaneHeaderDroppableId,
  groupEntriesByLane,
  laneArchiveIntent,
  laneColumnKeyFromSwimlaneDroppableId,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
  reorderBoardLaneKeys,
  rowKeyFromSwimlaneDroppableId,
  resolveBoardLaneDrop,
  resolveBoardFocusAction,
  resolveBoardScrollTarget,
  resolveBoardThreadVisibility,
  shouldHideSwimlaneProjectHeader,
  swimlaneColumnDroppableId,
} from "./SessionBoard.logic.ts";

const NOW = "2026-08-12T16:00:00.000Z";

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

const lifecycleOptions = {
  now: NOW,
  settlementNow: NOW,
  autoSettleAfterDays: 3,
  supportsSettlement: true,
  supportsSnooze: true,
  changeRequestState: null,
} as const;

describe("resolveBoardThreadVisibility", () => {
  it("hides archived threads and classifies snoozed and settled threads", () => {
    expect(
      resolveBoardThreadVisibility(
        threadShell({ archivedAt: "2026-08-12T15:30:00.000Z" }),
        lifecycleOptions,
      ),
    ).toBe("archived");
    expect(
      resolveBoardThreadVisibility(
        threadShell({
          snoozedAt: "2026-08-12T15:30:00.000Z",
          snoozedUntil: "2026-08-12T17:00:00.000Z",
        }),
        lifecycleOptions,
      ),
    ).toBe("snoozed");
    expect(
      resolveBoardThreadVisibility(
        threadShell({
          settledOverride: "settled",
          settledAt: "2026-08-12T15:30:00.000Z",
        }),
        lifecycleOptions,
      ),
    ).toBe("settled");
  });

  it("returns a thread when its lifecycle blocker makes it active again", () => {
    expect(
      resolveBoardThreadVisibility(
        threadShell({
          snoozedAt: "2026-08-12T15:30:00.000Z",
          snoozedUntil: "2026-08-12T17:00:00.000Z",
          hasPendingUserInput: true,
        }),
        lifecycleOptions,
      ),
    ).toBe("visible");
    expect(
      resolveBoardThreadVisibility(
        threadShell({
          settledOverride: "settled",
          settledAt: "2026-08-12T15:30:00.000Z",
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-2"),
            lastError: null,
            updatedAt: "2026-08-12T15:45:00.000Z",
          },
        }),
        lifecycleOptions,
      ),
    ).toBe("visible");
  });

  it("does not classify lifecycle states a connected server cannot manage", () => {
    const thread = threadShell({
      settledOverride: "settled",
      settledAt: "2026-08-12T15:30:00.000Z",
      snoozedAt: "2026-08-12T15:30:00.000Z",
      snoozedUntil: "2026-08-12T17:00:00.000Z",
    });
    expect(
      resolveBoardThreadVisibility(thread, {
        ...lifecycleOptions,
        supportsSettlement: false,
        supportsSnooze: false,
      }),
    ).toBe("visible");
  });

  it("keeps pinned threads visible instead of auto-settling them for inactivity", () => {
    const stalePinned = threadShell({
      pinnedAt: "2026-08-01T00:00:00.000Z",
      latestUserMessageAt: "2026-08-01T00:00:00.000Z",
      latestTurn: null,
    });
    expect(resolveBoardThreadVisibility(stalePinned, lifecycleOptions)).toBe("visible");
    expect(resolveBoardThreadVisibility({ ...stalePinned, pinnedAt: null }, lifecycleOptions)).toBe(
      "settled",
    );
  });

  it("matches sidebar settlement rules for open and completed pull requests", () => {
    const stale = threadShell({
      latestUserMessageAt: "2026-08-01T00:00:00.000Z",
      latestTurn: null,
    });

    expect(
      resolveBoardThreadVisibility(stale, {
        ...lifecycleOptions,
        changeRequestState: "open",
      }),
    ).toBe("visible");
    expect(
      resolveBoardThreadVisibility(threadShell(), {
        ...lifecycleOptions,
        changeRequestState: "merged",
      }),
    ).toBe("settled");
    expect(
      resolveBoardThreadVisibility(threadShell(), {
        ...lifecycleOptions,
        changeRequestState: "closed",
      }),
    ).toBe("settled");
  });
});

type TestPlacement = {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
  readonly updatedAt: string;
};

const laneKeys = ["lane-a", "lane-b", "lane-c"] as const;

function placement(
  projectKey: string,
  projectTitle: string,
  laneColumnKey: string,
  updatedAt: string,
): TestPlacement {
  return { projectKey, projectTitle, laneColumnKey, updatedAt };
}

const lanes: ReadonlyArray<BoardLane> = [
  {
    id: "shaping",
    name: "Shaping",
    description: "Work out the shape",
    order: 0,
  },
  {
    id: "ready",
    name: "Ready",
    description: "Ready to start",
    order: 10,
  },
  {
    id: "done",
    name: "Done",
    description: "Finished work",
    order: 20,
  },
];

const lanesWithFixedLifecycle: ReadonlyArray<BoardLane> = [
  { id: "triage", name: "Triage", description: "New work", order: 0 },
  { id: "blocked", name: "Blocked", description: "Waiting", order: 1 },
  { id: "ready", name: "Ready", description: "Ready", order: 2 },
  { id: "snoozed", name: "Snoozed", description: "Later", order: 50 },
  { id: "settled", name: "Settled", description: "Finished", order: 60 },
];

describe("laneIdForName", () => {
  it("creates a readable unique lane id without exposing id as an authoring field", () => {
    expect(laneIdForName("To Review", lanes)).toBe("to-review");
    expect(laneIdForName("Ready", lanes)).toBe("ready-2");
  });
});

describe("nextLaneOrder", () => {
  it("places a new lane after the highest existing order", () => {
    expect(nextLaneOrder(lanes)).toBe(21);
  });

  it("ignores fixed lifecycle tails when placing a new workflow lane", () => {
    expect(nextLaneOrder(lanesWithFixedLifecycle)).toBe(3);
  });
});

describe("reorderLaneUpdates", () => {
  it("swaps neighbouring lanes", () => {
    expect(reorderLaneUpdates(lanes, "ready", "up")).toEqual([
      { laneId: "ready", order: 0 },
      { laneId: "shaping", order: 10 },
    ]);
    expect(reorderLaneUpdates(lanes, "done", "down")).toEqual([]);
  });

  it("reorders only editable workflow lanes", () => {
    expect(reorderLaneUpdates(lanesWithFixedLifecycle, "ready", "up")).toEqual([
      { laneId: "ready", order: 1 },
      { laneId: "blocked", order: 2 },
    ]);
    expect(reorderLaneUpdates(lanesWithFixedLifecycle, "blocked", "up")).toEqual([]);
    expect(reorderLaneUpdates(lanesWithFixedLifecycle, "ready", "down")).toEqual([]);
  });
});

describe("buildProjectSwimlanes", () => {
  it("groups threads under projects sorted by name, not thread activity", () => {
    const entries = [
      placement("env:zeta", "Zeta", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:alpha", "alpha", "lane-b", "2026-01-01T00:00:00.000Z"),
      placement("env:zeta", "Zeta", "lane-c", "2026-01-04T00:00:00.000Z"),
    ];

    const swimlanes = buildProjectSwimlanes(entries, null);

    expect(swimlanes).toHaveLength(2);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
    expect(swimlanes[0]?.sessionCount).toBe(1);
    expect(swimlanes[1]?.projectKey).toBe("env:zeta");
    expect(swimlanes[1]?.sessionCount).toBe(2);
  });

  it("omits projects with no visible sessions after filtering", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    const swimlanes = buildProjectSwimlanes(entries, "env:alpha");

    expect(swimlanes).toHaveLength(1);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
  });

  it("uses one nullable project scope for filtering and project headers", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    expect(buildProjectSwimlanes(entries, null)).toHaveLength(2);
    expect(buildProjectSwimlanes(entries, "env:alpha")).toHaveLength(1);
    expect(shouldHideSwimlaneProjectHeader(null)).toBe(false);
    expect(shouldHideSwimlaneProjectHeader("env:alpha")).toBe(true);
  });

  it("keeps sessions from matching projects on separate environments in one logical group", () => {
    const entries = [
      placement("project:skills", "skills", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("project:skills", "skills", "lane-b", "2026-01-02T00:00:00.000Z"),
    ];

    const [skills] = buildProjectSwimlanes(entries, null);
    expect(skills?.projectKey).toBe("project:skills");
    expect(skills?.sessionCount).toBe(2);
    expect([...groupEntriesByLane(skills?.entries ?? [], laneKeys).entries()]).toEqual([
      ["lane-a", [entries[0]]],
      ["lane-b", [entries[1]]],
      ["lane-c", []],
    ]);
  });
});

describe("groupEntriesByLane", () => {
  it("keeps lane column order identical for every swimlane", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-c", "2026-01-01T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-a", "2026-01-02T00:00:00.000Z"),
    ];

    for (const swimlane of buildProjectSwimlanes(entries, null)) {
      expect([...groupEntriesByLane(swimlane.entries, laneKeys).keys()]).toEqual([...laneKeys]);
    }
  });
});

describe("boardLaneGridTemplateColumns", () => {
  it("keeps every local lane at its normal resizable width", () => {
    const columns = [
      { key: "triage", laneId: "triage" },
      { key: "snoozed", laneId: "snoozed" },
      { key: "settled", laneId: "settled" },
    ];

    expect(boardLaneGridTemplateColumns(columns)).toBe("380px 380px 380px");
    expect(boardLaneGridTemplateColumns(columns, { triage: 460 })).toBe("460px 380px 380px");
  });
});

describe("swimlaneColumnDroppableId", () => {
  it("round-trips lane column keys for drag and drop targets", () => {
    const droppableId = swimlaneColumnDroppableId("env:alpha", laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
    expect(rowKeyFromSwimlaneDroppableId(droppableId)).toBe("env:alpha");
  });

  it("makes the continuous lane header a real drop target", () => {
    const droppableId = boardLaneHeaderDroppableId(laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
    expect(rowKeyFromSwimlaneDroppableId(droppableId)).toBe("board-lane-header");
  });
});

describe("resolveBoardLaneDrop", () => {
  const entries = [
    { key: "env-a:thread-1", environmentId: "env-a", laneColumnKey: laneKeys[0] },
    { key: "env-b:thread-2", environmentId: "env-b", laneColumnKey: laneKeys[1] },
  ];
  const columns = [{ key: laneKeys[0] }, { key: laneKeys[1] }];

  it("resolves a drop from its active card and local target id", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: boardLaneHeaderDroppableId(columns[0]!.key),
        entries,
        columns,
      }),
    ).toEqual({ entry: entries[0], target: columns[0], overEntry: null });
  });

  it("allows a card from any environment to enter a local lane", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: swimlaneColumnDroppableId("project", columns[1]!.key),
        entries,
        columns,
      }),
    ).toEqual({ entry: entries[0], target: columns[1], overEntry: null });
  });

  it("uses another card as a precise within-lane drop target", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: entries[1]!.key,
        entries,
        columns,
      }),
    ).toEqual({ entry: entries[0], target: columns[1], overEntry: entries[1] });
  });
});

describe("reorderBoardLaneKeys", () => {
  it("moves a card above or below the hovered member", () => {
    expect(
      reorderBoardLaneKeys({
        orderedKeys: ["a", "b", "c"],
        activeKey: "c",
        overKey: "b",
        insertAfter: false,
      }),
    ).toEqual(["a", "c", "b"]);
    expect(
      reorderBoardLaneKeys({
        orderedKeys: ["a", "b", "c"],
        activeKey: "a",
        overKey: "b",
        insertAfter: true,
      }),
    ).toEqual(["b", "a", "c"]);
  });
});

describe("laneArchiveIntent", () => {
  it("requires member-aware confirmation before archiving a populated lane", () => {
    expect(laneArchiveIntent("ready", 3)).toEqual({
      kind: "confirm",
      memberCount: 3,
      explanation:
        "Archive this lane? Its 3 sessions will return to the leftmost lane on this board.",
    });
  });

  it("allows an empty lane to be archived immediately", () => {
    expect(laneArchiveIntent("done", 0)).toEqual({ kind: "archive" });
  });
});

describe("resolveBoardFocusAction", () => {
  const viewport = { top: 0, bottom: 800, left: 0, right: 1200 };

  it("reveals a card that is not rendered at all", () => {
    expect(
      resolveBoardFocusAction({
        card: null,
        viewport,
        requestNonce: 1,
        acknowledgedRequestNonce: null,
      }),
    ).toBe("reveal");
  });

  it("reveals a card scrolled off the bottom", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 900, bottom: 1160, left: 0, right: 380 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: 1,
      }),
    ).toBe("reveal");
  });

  it("reveals a card in a column scrolled off to the right", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 1180, right: 1560 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: 1,
      }),
    ).toBe("reveal");
  });

  it("reveals and focuses on the first request even when the card is visible", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        requestNonce: 1,
        acknowledgedRequestNonce: null,
      }),
    ).toBe("reveal");
  });

  it("opens on a subsequent request after focus was acknowledged", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: 1,
      }),
    ).toBe("open");
  });

  it("does not open when the current request has not been acknowledged", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: null,
      }),
    ).toBe("reveal");
  });

  it("does not treat acknowledgement of the same request as permission to open", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: 2,
      }),
    ).toBe("reveal");
  });

  it("does not give a double-click request an acknowledgement bypass", () => {
    expect(
      resolveBoardFocusAction({
        card: { top: 100, bottom: 360, left: 20, right: 400 },
        viewport,
        requestNonce: 2,
        acknowledgedRequestNonce: null,
      }),
    ).toBe("reveal");
  });
});

describe("resolveBoardScrollTarget", () => {
  it("centers a fitting card inside the unobscured viewport", () => {
    expect(
      resolveBoardScrollTarget({
        card: { top: 500, bottom: 1020, left: 900, right: 1280 },
        viewport: { top: 100, bottom: 900, left: 200, right: 1200 },
        scrollTop: 300,
        scrollLeft: 400,
      }),
    ).toEqual({ top: 560, left: 790 });
  });

  it("top-aligns a card that is taller than the available viewport", () => {
    expect(
      resolveBoardScrollTarget({
        card: { top: 600, bottom: 1500, left: 100, right: 480 },
        viewport: { top: 120, bottom: 820, left: 0, right: 1200 },
        scrollTop: 250,
        scrollLeft: 0,
      }),
    ).toEqual({ top: 730, left: 0 });
  });
});
