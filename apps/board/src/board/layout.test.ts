import { describe, expect, it } from "vite-plus/test";

import type { Ticket } from "../domain/ticket";
import type { AgentView, BoardModel, TicketView } from "../state/boardModel";
import {
  artifactsHeight,
  clampDrag,
  edgePath,
  FRAME_WIDTH,
  frameHeight,
  headHeight,
  LANE_GAP,
  LANE_HEAD,
  LANE_PAD,
  LANE_WIDTH,
  LANES_TOP,
  layoutBoard,
  orderedKeys,
  reorderByDrag,
  UNASSIGNED_KEY,
} from "./layout";

const agent = (threadId: string): AgentView => ({
  threadId,
  title: threadId,
  role: "task",
  registered: true,
  outsideRegistry: false,
  ticketKey: null,
  driver: null,
  runState: "idle",
  pendingRequest: false,
  branch: null,
  parentThreadId: null,
  round: null,
});

const view = (ticket: Ticket, agents = 0): TicketView => ({
  ticket,
  agents: Array.from({ length: agents }, (_, index) => agent(`${ticket.key}-${index}`)),
});
const empty: BoardModel["lanes"] = {
  planned: [],
  building: [],
  reviewing: [],
  verifying: [],
  pr: [],
  awaiting_approval: [],
  merged: [],
  off_path: [],
};

const model: BoardModel = {
  lanes: {
    ...empty,
    planned: [view({ key: "T-3", title: "c", stage: "planned", dependsOn: ["T-1"] })],
    building: [
      view({ key: "T-1", title: "a", stage: "building" }, 2),
      view({ key: "T-2", title: "b", stage: "building", dependsOn: ["T-1", "T-404"] }),
    ],
  },
  unassigned: [],
};

describe("laying out the lanes", () => {
  const layout = layoutBoard(model, {});
  const lane = (id: string) => layout.lanes.find((entry) => entry.id === id);

  it("Given tickets in two stages, when laid out, then each frame sits in its stage's column and frames stack in file order", () => {
    expect(layout.lanes.map((entry) => entry.id)).toEqual([
      "for_you",
      "planned",
      "building",
      "reviewing",
      "verifying",
      "pr",
      "awaiting_approval",
      "merged",
      "off_path",
    ]);
    const building = lane("building");
    expect(building?.x).toBe(40 + 2 * (LANE_WIDTH + LANE_GAP));
    expect(building?.frames.map((frame) => [frame.key, frame.x, frame.y])).toEqual([
      ["T-1", building!.x + LANE_PAD, LANES_TOP + LANE_HEAD],
      [
        "T-2",
        building!.x + LANE_PAD,
        LANES_TOP + LANE_HEAD + frameHeight(headHeight(model.lanes.building[0]!.ticket), 2) + 12,
      ],
    ]);
    expect(building?.frames[0]?.width).toBe(FRAME_WIDTH);
  });

  it("Given a ticket with open artifact cards, when laid out, then its frame grows by the cards and the frame below moves down", () => {
    const open = layoutBoard(model, {}, 0, { "T-1": 3 });
    const frame = (laid: typeof layout, key: string) =>
      laid.lanes.flatMap((entry) => entry.frames).find((box) => box.key === key);
    const grown = artifactsHeight(3);
    expect(frame(open, "T-1")?.height).toBe((frame(layout, "T-1")?.height ?? 0) + grown);
    expect(frame(open, "T-2")?.y).toBe((frame(layout, "T-2")?.y ?? 0) + grown);
  });

  it("Given a dependency on a ticket that exists and one that does not, when laid out, then only the first has an edge", () => {
    expect(layout.edges).toEqual([
      { from: "T-1", to: "T-3" },
      { from: "T-1", to: "T-2" },
    ]);
  });

  it("Given agents no ticket claims, when laid out, then an unassigned lane follows the others", () => {
    const withOrphan = layoutBoard({ ...model, unassigned: [agent("orphan")] }, {});
    const last = withOrphan.lanes.at(-1);
    expect(last?.id).toBe("unassigned");
    expect(last?.frames.map((frame) => frame.key)).toEqual([UNASSIGNED_KEY]);
  });

  it("Given a saved order, when laid out, then it wins and new tickets follow", () => {
    expect(orderedKeys(["T-1", "T-2", "T-4"], ["T-2", "T-9", "T-1"])).toEqual([
      "T-2",
      "T-1",
      "T-4",
    ]);
    const moved = layoutBoard(model, { building: ["T-2", "T-1"] });
    expect(moved.lanes.find((entry) => entry.id === "building")?.frames.map((f) => f.key)).toEqual([
      "T-2",
      "T-1",
    ]);
  });
});

describe("dragging a frame", () => {
  const building = layoutBoard(model, {}).lanes.find((entry) => entry.id === "building")!;
  const [first] = building.frames;
  if (first === undefined) throw new Error("the building lane has no frame");

  it("Given a frame dragged past its neighbor's center, when dropped, then it takes the neighbor's place", () => {
    expect(reorderByDrag(building, "T-1", first.height)).toEqual(["T-2", "T-1"]);
    expect(reorderByDrag(building, "T-2", -first.height)).toEqual(["T-2", "T-1"]);
  });

  it("Given a short drag, when dropped, then the order stays", () => {
    expect(reorderByDrag(building, "T-1", 10)).toEqual(["T-1", "T-2"]);
  });

  it("Given a drag past the lane, when clamped, then the frame stays inside it", () => {
    expect(clampDrag(building, first, -500)).toBe(0);
    expect(clampDrag(building, first, 5000)).toBe(
      building.y + building.height - LANE_PAD - first.height - first.y,
    );
  });
});

describe("dependency edges", () => {
  const box = (x: number, y: number) => ({ key: "k", head: 100, x, y, width: 264, height: 100 });

  it("Given a dependent in a later lane, when drawn, then the curve runs from the right edge to the left edge", () => {
    expect(edgePath(box(0, 0), box(300, 200))).toBe("M 264 24 C 304 24, 260 224, 300 224");
  });

  it("Given a dependent in an earlier lane, when drawn, then it runs from the left edge to the right edge", () => {
    expect(edgePath(box(300, 0), box(0, 200))).toBe("M 300 24 C 260 24, 304 224, 264 224");
  });

  it("Given two frames in one lane, when drawn, then the curve bows out on the left", () => {
    expect(edgePath(box(0, 0), box(0, 200))).toBe("M 0 24 C -40 24, -40 224, 0 224");
  });
});
