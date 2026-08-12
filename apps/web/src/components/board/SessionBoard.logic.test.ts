import { describe, expect, it } from "vite-plus/test";
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
  resolveBoardLaneDrop,
  resolveBoardFocusAction,
  shouldHideSwimlaneProjectHeader,
  swimlaneColumnDroppableId,
} from "./SessionBoard.logic.ts";

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
});

describe("reorderLaneUpdates", () => {
  it("swaps neighbouring lanes", () => {
    expect(reorderLaneUpdates(lanes, "ready", "up")).toEqual([
      { laneId: "ready", order: 0 },
      { laneId: "shaping", order: 10 },
    ]);
    expect(reorderLaneUpdates(lanes, "done", "down")).toEqual([]);
  });
});

describe("buildProjectSwimlanes", () => {
  it("groups threads under the right project", () => {
    const entries = [
      placement("env:alpha", "Alpha", "lane-a", "2026-01-03T00:00:00.000Z"),
      placement("env:beta", "Beta", "lane-b", "2026-01-02T00:00:00.000Z"),
      placement("env:alpha", "Alpha", "lane-c", "2026-01-01T00:00:00.000Z"),
    ];

    const swimlanes = buildProjectSwimlanes(entries, null);

    expect(swimlanes).toHaveLength(2);
    expect(swimlanes[0]?.projectKey).toBe("env:alpha");
    expect(swimlanes[0]?.sessionCount).toBe(2);
    expect(swimlanes[1]?.projectKey).toBe("env:beta");
    expect(swimlanes[1]?.sessionCount).toBe(1);
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
  });

  it("makes the continuous lane header a real drop target", () => {
    const droppableId = boardLaneHeaderDroppableId(laneKeys[1]);
    expect(laneColumnKeyFromSwimlaneDroppableId(droppableId)).toBe(laneKeys[1]);
  });
});

describe("resolveBoardLaneDrop", () => {
  const entries = [
    { key: "env-a:thread-1", environmentId: "env-a" },
    { key: "env-b:thread-2", environmentId: "env-b" },
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
    ).toEqual({ entry: entries[0], target: columns[0] });
  });

  it("allows a card from any environment to enter a local lane", () => {
    expect(
      resolveBoardLaneDrop({
        activeId: entries[0]!.key,
        overId: swimlaneColumnDroppableId("project", columns[1]!.key),
        entries,
        columns,
      }),
    ).toEqual({ entry: entries[0], target: columns[1] });
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
