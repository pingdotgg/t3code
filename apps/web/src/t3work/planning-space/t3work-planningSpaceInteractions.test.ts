import { describe, expect, it } from "vite-plus/test";

import {
  type DropContext,
  type InteractionState,
  type PlanningEvent,
  type PlanningIntent,
  initialInteractionState,
  reducePlanningEvent,
} from "./t3work-planningSpaceInteractions";

const DROP_EPIC: DropContext = {
  grouping: "epic",
  sprintBoundaryX: 0,
  ownerClusters: [],
};

function run(
  events: ReadonlyArray<PlanningEvent>,
  from: InteractionState = initialInteractionState,
): { state: InteractionState; intents: PlanningIntent[] } {
  let state = from;
  const intents: PlanningIntent[] = [];
  for (const event of events) {
    const result = reducePlanningEvent(state, event);
    state = result.state;
    intents.push(...result.intents);
  }
  return { state, intents };
}

const frameHit = { type: "frame", storyId: "S1", band: 3 } as const;
const subtaskHit = {
  type: "subtask",
  storyId: "S1",
  subtaskId: "T1",
  band: 3,
} as const;

describe("click vs drag threshold", () => {
  it("treats movement under the threshold as a click (opens detail)", () => {
    const { intents } = run([
      { type: "pointerDown", hit: frameHit, x: 100, y: 100 },
      { type: "pointerMove", x: 102, y: 101, worldX: 0, worldY: 0 },
      { type: "pointerUp", hit: frameHit, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(intents).toEqual([{ type: "openDetail", item: { kind: "story", storyId: "S1" } }]);
  });

  it("treats movement over the threshold on a card as a PAN, never a click or drag", () => {
    const { intents } = run([
      { type: "pointerDown", hit: frameHit, x: 100, y: 100 },
      { type: "pointerMove", x: 140, y: 120, worldX: 50, worldY: 20 },
      { type: "pointerUp", hit: { type: "background" }, worldX: 50, worldY: 20, drop: DROP_EPIC },
    ]);
    expect(intents.some((i) => i.type === "openDetail")).toBe(false);
    expect(intents[0]?.type).toBe("panBy");
  });
});

describe("assignment — one primitive, every path (§6.2)", () => {
  it("drags a person onto a subtask card", () => {
    const { intents } = run([
      { type: "pointerDown", hit: { type: "dock", ownerId: "carol" }, x: 0, y: 0 },
      { type: "pointerMove", x: 80, y: 0, worldX: 0, worldY: 0 },
      { type: "pointerUp", hit: subtaskHit, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(intents).toContainEqual({
      type: "assign",
      item: { kind: "subtask", storyId: "S1", subtaskId: "T1" },
      ownerId: "carol",
    });
  });

  it("runs assign mode: owner affordance click, then dock click", () => {
    const affordance = {
      type: "ownerAffordance",
      item: { kind: "subtask", storyId: "S1", subtaskId: "T1" },
    } as const;
    const { intents, state } = run([
      { type: "pointerDown", hit: affordance, x: 0, y: 0 },
      { type: "pointerUp", hit: affordance, worldX: 0, worldY: 0, drop: DROP_EPIC },
      { type: "pointerDown", hit: { type: "dock", ownerId: "dora" }, x: 0, y: 0 },
      {
        type: "pointerUp",
        hit: { type: "dock", ownerId: "dora" },
        worldX: 0,
        worldY: 0,
        drop: DROP_EPIC,
      },
    ]);
    expect(intents).toContainEqual({
      type: "assignModeStart",
      item: { kind: "subtask", storyId: "S1", subtaskId: "T1" },
    });
    expect(intents).toContainEqual({
      type: "assign",
      item: { kind: "subtask", storyId: "S1", subtaskId: "T1" },
      ownerId: "dora",
    });
    expect(state.assignTarget).toBeNull();
  });

  it("never starts an item drag — cards drop nothing on docks (PJ: no node dragging)", () => {
    const { intents } = run([
      { type: "pointerDown", hit: frameHit, x: 0, y: 0 },
      { type: "pointerMove", x: 50, y: 60, worldX: 10, worldY: 10 },
      {
        type: "pointerUp",
        hit: { type: "dock", ownerId: "alice" },
        worldX: 10,
        worldY: 10,
        drop: DROP_EPIC,
      },
    ]);
    expect(intents.some((i) => i.type === "assign")).toBe(false);
    expect(intents[0]?.type).toBe("panBy");
  });
});

describe("group anchors (§6.1)", () => {
  it("click toggles spotlight on and off", () => {
    const dock = { type: "dock", ownerId: "alice" } as const;
    const first = run([
      { type: "pointerDown", hit: dock, x: 0, y: 0 },
      { type: "pointerUp", hit: dock, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(first.state.spotlight).toEqual({ kind: "owner", ownerId: "alice" });
    const second = run(
      [
        { type: "pointerDown", hit: dock, x: 0, y: 0 },
        { type: "pointerUp", hit: dock, worldX: 0, worldY: 0, drop: DROP_EPIC },
      ],
      first.state,
    );
    expect(second.state.spotlight).toBeNull();
  });

  it("double-click frames the group", () => {
    const { intents } = run([
      { type: "doubleClick", hit: { type: "epicTile", epicId: "E1" } },
    ]);
    expect(intents).toEqual([
      { type: "frameGroup", group: { kind: "epic", epicId: "E1" } },
    ]);
  });

  it("single-click on an epic anchor flies into the cluster, never spotlights", () => {
    const epic = { type: "epicAnchor", epicId: "E2" } as const;
    const { intents, state } = run([
      { type: "pointerDown", hit: epic, x: 0, y: 0 },
      { type: "pointerUp", hit: epic, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(intents).toEqual([
      { type: "frameGroup", group: { kind: "epic", epicId: "E2" } },
    ]);
    expect(state.spotlight).toBeNull();
  });

  it("double-click on an item emits the quick-zoom intent", () => {
    const { intents } = run([{ type: "doubleClick", hit: frameHit }]);
    expect(intents).toEqual([
      { type: "frameItem", item: { kind: "story", storyId: "S1" } },
    ]);
  });
});

describe("details (§6.4)", () => {
  it("opens the subtask's own detail, not the parent story's", () => {
    const { intents } = run([
      { type: "pointerDown", hit: subtaskHit, x: 0, y: 0 },
      { type: "pointerUp", hit: subtaskHit, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(intents).toEqual([
      {
        type: "openDetail",
        item: { kind: "subtask", storyId: "S1", subtaskId: "T1" },
      },
    ]);
  });

  it("suppresses detail clicks at the Full band (§3.5)", () => {
    const fullBand = { ...frameHit, band: 5 } as const;
    const { intents } = run([
      { type: "pointerDown", hit: fullBand, x: 0, y: 0 },
      { type: "pointerUp", hit: fullBand, worldX: 0, worldY: 0, drop: DROP_EPIC },
    ]);
    expect(intents).toEqual([]);
  });
});

describe("escape ladder (§6.7)", () => {
  it("walks drag → detail → assign mode → spotlight, one level per press", () => {
    let state: InteractionState = {
      ...initialInteractionState,
      dragging: { kind: "person", ownerId: "alice" },
      detail: { kind: "story", storyId: "S2" },
      assignTarget: { kind: "story", storyId: "S3" },
      spotlight: { kind: "owner", ownerId: "alice" },
    };
    const steps: PlanningIntent["type"][] = [];
    for (let i = 0; i < 4; i++) {
      const result = reducePlanningEvent(state, { type: "escape" });
      state = result.state;
      steps.push(...result.intents.map((intent) => intent.type));
    }
    expect(steps).toEqual([
      "personDragEnd",
      "closeDetail",
      "assignModeEnd",
      "spotlightClear",
    ]);
    expect(reducePlanningEvent(state, { type: "escape" }).intents).toEqual([]);
  });
});

describe("background clicks", () => {
  it("close detail and end assign mode together", () => {
    const state: InteractionState = {
      ...initialInteractionState,
      detail: { kind: "story", storyId: "S1" },
      assignTarget: { kind: "story", storyId: "S2" },
    };
    const { intents, state: after } = run(
      [
        { type: "pointerDown", hit: { type: "background" }, x: 0, y: 0 },
        {
          type: "pointerUp",
          hit: { type: "background" },
          worldX: 0,
          worldY: 0,
          drop: DROP_EPIC,
        },
      ],
      state,
    );
    expect(intents.map((i) => i.type).sort()).toEqual([
      "assignModeEnd",
      "closeDetail",
    ]);
    expect(after.detail).toBeNull();
    expect(after.assignTarget).toBeNull();
  });
});
