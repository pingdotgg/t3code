import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  BOARD_LANE_DEFAULT_WIDTH,
  BOARD_LANE_MAX_WIDTH,
  BOARD_LANE_MIN_WIDTH,
  DEFAULT_BOARD_ORGANIZATION,
  DEFAULT_BOARD_LANES,
  orderBoardLaneEntries,
  selectBoardLaneWidth,
  selectBoardPlacement,
  useBoardLaneStore,
} from "./boardLaneStore.ts";

const laneA = "triage";
const laneB = "ready";
const firstThread = scopeThreadRef("env-a" as EnvironmentId, ThreadId.make("thread-1"));
const sameIdElsewhere = scopeThreadRef("env-b" as EnvironmentId, ThreadId.make("thread-1"));

beforeEach(() => {
  useBoardLaneStore.setState({
    lanes: DEFAULT_BOARD_LANES,
    placementByThreadKey: {},
    laneEntryByThreadKey: {},
    orderByLaneId: {},
    byLaneColumnKey: {},
    collapsedLifecycleLaneIds: [],
    organization: DEFAULT_BOARD_ORGANIZATION,
  });
});

describe("boardLaneStore", () => {
  it("starts fresh boards with the traditional workflow and lifecycle lanes", () => {
    expect(DEFAULT_BOARD_LANES.map((lane) => lane.id)).toEqual([
      "triage",
      "blocked",
      "ready",
      "in-progress",
      "review",
      "snoozed",
      "settled",
    ]);
  });

  it("setWidth clamps to the min/max lane width", () => {
    expect(BOARD_LANE_MAX_WIDTH).toBe(1316);

    useBoardLaneStore.getState().setWidth(laneA, BOARD_LANE_MIN_WIDTH - 100);
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneA)).toBe(
      BOARD_LANE_MIN_WIDTH,
    );

    useBoardLaneStore.getState().setWidth(laneA, BOARD_LANE_MAX_WIDTH + 100);
    expect(selectBoardLaneWidth(useBoardLaneStore.getState().byLaneColumnKey, laneA)).toBe(
      BOARD_LANE_MAX_WIDTH,
    );
  });

  it("keeps placements scoped when environments reuse a thread id", () => {
    const store = useBoardLaneStore.getState();
    store.setPlacement(firstThread, "ready");
    store.setPlacement(sameIdElsewhere, "triage");

    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, firstThread),
    ).toBe("ready");
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, sameIdElsewhere),
    ).toBe("triage");
  });

  it("records a fresh lane-entry time and removes stale manual order on placement", () => {
    useBoardLaneStore.setState({
      orderByLaneId: { triage: ["env-a:thread-1"] },
    });

    useBoardLaneStore.getState().setPlacement(firstThread, "ready");

    const state = useBoardLaneStore.getState();
    expect(state.laneEntryByThreadKey["env-a:thread-1"]?.laneId).toBe("ready");
    expect(Date.parse(state.laneEntryByThreadKey["env-a:thread-1"]?.enteredAt ?? "")).not.toBeNaN();
    expect(state.orderByLaneId).toEqual({});
  });

  it("records a derived lane entry without changing workflow placement", () => {
    useBoardLaneStore.setState({
      placementByThreadKey: { "env-a:thread-1": "ready" },
      laneEntryByThreadKey: {
        "env-a:thread-1": {
          laneId: "ready",
          enteredAt: "2026-01-01T00:00:00.000Z",
        },
      },
      orderByLaneId: { ready: ["env-a:thread-1"] },
    });

    useBoardLaneStore
      .getState()
      .recordLaneEntry(firstThread, "snoozed", "2026-02-01T00:00:00.000Z");

    const state = useBoardLaneStore.getState();
    expect(state.placementByThreadKey).toEqual({ "env-a:thread-1": "ready" });
    expect(state.laneEntryByThreadKey["env-a:thread-1"]).toEqual({
      laneId: "snoozed",
      enteredAt: "2026-02-01T00:00:00.000Z",
    });
    expect(state.orderByLaneId).toEqual({});
  });

  it("ignores workflow placement in lifecycle or unknown lanes", () => {
    const store = useBoardLaneStore.getState();
    store.setPlacement(firstThread, "snoozed");
    store.setPlacement(firstThread, "settled");
    store.setPlacement(firstThread, "missing");

    expect(useBoardLaneStore.getState().placementByThreadKey).toEqual({});
  });

  it("stores a deduplicated manual sequence for a lane", () => {
    useBoardLaneStore
      .getState()
      .setLaneOrder("triage", ["env-a:thread-2", "env-a:thread-1", "env-a:thread-2"]);

    expect(useBoardLaneStore.getState().orderByLaneId).toEqual({
      triage: ["env-a:thread-2", "env-a:thread-1"],
    });
  });

  it("orders by lane entry until a manual sequence takes over", () => {
    const entries = [
      { key: "env-a:older", laneId: "triage", createdAt: "2026-01-01T00:00:00.000Z" },
      { key: "env-a:newer", laneId: "triage", createdAt: "2026-01-02T00:00:00.000Z" },
    ];

    expect(orderBoardLaneEntries(entries, {}, {}).map((entry) => entry.key)).toEqual([
      "env-a:newer",
      "env-a:older",
    ]);
    expect(
      orderBoardLaneEntries(
        entries,
        {
          "env-a:older": {
            laneId: "triage",
            enteredAt: "2026-01-03T00:00:00.000Z",
          },
        },
        {},
      ).map((entry) => entry.key),
    ).toEqual(["env-a:older", "env-a:newer"]);
    expect(
      orderBoardLaneEntries(entries, {}, { triage: ["env-a:older", "env-a:newer"] }).map(
        (entry) => entry.key,
      ),
    ).toEqual(["env-a:older", "env-a:newer"]);
  });

  it("ignores live activity timestamps when ordering cards", () => {
    const entries = [
      {
        key: "env-a:first",
        laneId: "triage",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
      },
      {
        key: "env-a:second",
        laneId: "triage",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];

    expect(orderBoardLaneEntries(entries, {}, {}).map((entry) => entry.key)).toEqual([
      "env-a:second",
      "env-a:first",
    ]);
    expect(
      orderBoardLaneEntries(
        entries.map((entry) => ({ ...entry, updatedAt: "2026-12-31T00:00:00.000Z" })),
        {},
        {},
      ).map((entry) => entry.key),
    ).toEqual(["env-a:second", "env-a:first"]);
  });

  it("places arrivals above an existing manual sequence", () => {
    const entries = [
      { key: "env-a:first", laneId: "ready", createdAt: "2026-01-01T00:00:00.000Z" },
      { key: "env-a:second", laneId: "ready", createdAt: "2026-01-02T00:00:00.000Z" },
      { key: "env-a:new", laneId: "ready", createdAt: "2026-01-03T00:00:00.000Z" },
    ];

    expect(
      orderBoardLaneEntries(entries, {}, { ready: ["env-a:first", "env-a:second"] }).map(
        (entry) => entry.key,
      ),
    ).toEqual(["env-a:new", "env-a:first", "env-a:second"]);
  });

  it("archives a lane locally and returns its members to implicit placement", () => {
    const store = useBoardLaneStore.getState();
    store.createLane({ id: "ready", name: "Ready", description: "Ready", order: 2 });
    store.setPlacement(firstThread, "ready");
    store.archiveLane("ready");

    expect(useBoardLaneStore.getState().lanes.map((lane) => lane.id)).not.toContain("ready");
    expect(
      selectBoardPlacement(useBoardLaneStore.getState().placementByThreadKey, firstThread),
    ).toBeUndefined();
  });

  it("protects fixed lanes from updates and archival", () => {
    const original = useBoardLaneStore.getState().lanes;
    useBoardLaneStore.getState().updateLane("triage", {
      name: "Inbox",
      description: "Changed",
      order: 99,
    });
    useBoardLaneStore.getState().archiveLane("triage");
    useBoardLaneStore.getState().archiveLane("snoozed");
    useBoardLaneStore.getState().archiveLane("settled");

    expect(useBoardLaneStore.getState().lanes).toEqual(original);
  });

  it("persists collapse only for lifecycle lanes", () => {
    const store = useBoardLaneStore.getState();
    store.toggleLifecycleLaneCollapsed("triage");
    store.toggleLifecycleLaneCollapsed("snoozed");
    store.toggleLifecycleLaneCollapsed("settled");
    expect(useBoardLaneStore.getState().collapsedLifecycleLaneIds).toEqual(["snoozed", "settled"]);

    useBoardLaneStore.getState().toggleLifecycleLaneCollapsed("snoozed");
    expect(useBoardLaneStore.getState().collapsedLifecycleLaneIds).toEqual(["settled"]);
  });

  it("persists local lanes, placements, widths, and board organization", () => {
    const store = useBoardLaneStore.getState();
    store.setPlacement(firstThread, "triage");
    store.setWidth(laneA, 420);
    store.setOrganizationColumns("state");
    store.setOrganizationRows("none");

    const persisted = useBoardLaneStore.persist
      .getOptions()
      .partialize?.(useBoardLaneStore.getState()) as {
      lanes?: unknown;
      placementByThreadKey?: unknown;
      laneEntryByThreadKey?: unknown;
      orderByLaneId?: unknown;
      collapsedLifecycleLaneIds?: unknown;
      organization?: unknown;
    };
    expect(persisted.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(persisted.placementByThreadKey).toEqual({ "env-a:thread-1": "triage" });
    expect(persisted.laneEntryByThreadKey).toEqual({
      "env-a:thread-1": expect.objectContaining({ laneId: "triage" }),
    });
    expect(persisted.orderByLaneId).toEqual({});
    expect(persisted.collapsedLifecycleLaneIds).toEqual([]);
    expect(persisted.organization).toEqual({ columns: "state", rows: "none" });
  });

  it("resolves organization conflicts in favor of the axis selected last", () => {
    const store = useBoardLaneStore.getState();

    store.setOrganizationRows("state");
    expect(useBoardLaneStore.getState().organization).toEqual({
      columns: "workflow",
      rows: "state",
    });

    store.setOrganizationColumns("state");
    expect(useBoardLaneStore.getState().organization).toEqual({
      columns: "state",
      rows: "project",
    });

    store.setOrganizationRows("state");
    expect(useBoardLaneStore.getState().organization).toEqual({
      columns: "workflow",
      rows: "state",
    });
  });

  it.each([
    { groupByProject: true, rows: "project" },
    { groupByProject: false, rows: "none" },
  ] as const)("migrates version four project grouping", ({ groupByProject, rows }) => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };

    expect(
      persistApi.getOptions().migrate(
        {
          lanes: DEFAULT_BOARD_LANES,
          collapsedLifecycleLaneIds: ["snoozed"],
          groupByProject,
        },
        4,
      ),
    ).toEqual({
      lanes: DEFAULT_BOARD_LANES,
      collapsedLifecycleLaneIds: ["snoozed"],
      organization: { columns: "workflow", rows },
    });
  });

  it("normalizes malformed and state-by-state organization to the default", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };

    for (const organization of [
      { columns: "state", rows: "state" },
      { columns: "missing", rows: "project" },
      null,
    ]) {
      const merged = persistApi
        .getOptions()
        .merge({ organization }, useBoardLaneStore.getInitialState());
      expect(merged.organization).toEqual(DEFAULT_BOARD_ORGANIZATION);
    }

    const valid = persistApi
      .getOptions()
      .merge(
        { organization: { columns: "workflow", rows: "state" } },
        useBoardLaneStore.getInitialState(),
      );
    expect(valid.organization).toEqual({ columns: "workflow", rows: "state" });
  });

  it("migrates the old environment-scoped store without importing server organization", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const migrated = persistApi.getOptions().migrate(
      {
        byLaneColumnKey: { '["env-a","triage"]': { widthPx: 460 } },
        selectedEnvironmentId: "env-a",
        groupByProject: false,
      },
      1,
    );
    const mergedState = persistApi
      .getOptions()
      .merge(migrated, useBoardLaneStore.getInitialState());

    expect(mergedState.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(mergedState.placementByThreadKey).toEqual({});
    expect(mergedState.laneEntryByThreadKey).toEqual({});
    expect(mergedState.orderByLaneId).toEqual({});
    expect(mergedState.collapsedLifecycleLaneIds).toEqual([]);
    expect(mergedState.organization).toEqual({ columns: "workflow", rows: "none" });
    expect(mergedState.byLaneColumnKey).toEqual({ '["env-a","triage"]': { widthPx: 460 } });
  });

  it("adds ordering state without discarding version two board placement", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };
    const versionTwoState = {
      lanes: DEFAULT_BOARD_LANES,
      placementByThreadKey: { "env-a:thread-1": "ready" },
      byLaneColumnKey: { ready: { widthPx: 440 } },
      groupByProject: false,
    };

    expect(persistApi.getOptions().migrate(versionTwoState, 2)).toEqual({
      lanes: DEFAULT_BOARD_LANES,
      placementByThreadKey: { "env-a:thread-1": "ready" },
      byLaneColumnKey: { ready: { widthPx: 440 } },
      laneEntryByThreadKey: {},
      orderByLaneId: {},
      collapsedLifecycleLaneIds: [],
      organization: { columns: "workflow", rows: "none" },
    });
  });

  it("preserves custom lanes while injecting canonical fixed lanes in version four", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const migrated = persistApi.getOptions().migrate(
      {
        lanes: [
          { id: "triage", name: "Moved", description: "Moved", order: 100 },
          { id: "shaping", name: "Shaping", description: "Custom workflow", order: 4 },
        ],
        placementByThreadKey: {
          "env-a:thread-1": "shaping",
          "env-a:removed": null,
          "env-a:lifecycle": "snoozed",
        },
        laneEntryByThreadKey: {
          "env-a:thread-1": {
            laneId: "shaping",
            enteredAt: "2026-01-01T00:00:00.000Z",
          },
        },
        orderByLaneId: { shaping: ["env-a:thread-1"] },
      },
      3,
    );
    const merged = persistApi.getOptions().merge(migrated, useBoardLaneStore.getInitialState());

    expect(merged.lanes.map((lane) => lane.id)).toEqual([
      "triage",
      "shaping",
      "snoozed",
      "settled",
    ]);
    expect(merged.lanes[0]).toEqual(DEFAULT_BOARD_LANES[0]);
    expect(merged.placementByThreadKey).toEqual({ "env-a:thread-1": "shaping" });
    expect(merged.laneEntryByThreadKey["env-a:thread-1"]?.laneId).toBe("shaping");
    expect(merged.orderByLaneId).toEqual({ shaping: ["env-a:thread-1"] });
    expect(merged.collapsedLifecycleLaneIds).toEqual([]);
  });

  it("remaps version two placements before upgrading untouched legacy defaults", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const migrated = persistApi.getOptions().migrate(
      {
        lanes: [
          {
            id: "triage",
            name: "Triage",
            description: "New and unplaced sessions start here until you file them elsewhere",
            order: -1,
          },
          {
            id: "shaping",
            name: "Grilling / shaping",
            description: "Working out what this actually is",
            order: 0,
          },
          {
            id: "ready",
            name: "Ready",
            description: "Groomed and ready to pick up",
            order: 1,
          },
          {
            id: "done",
            name: "Done",
            description: "Finished work you want to keep visible on this board",
            order: 2,
          },
        ],
        placementByThreadKey: {
          "env-a:shaping": "shaping",
          "env-a:done": "done",
        },
      },
      2,
    );
    const merged = persistApi.getOptions().merge(migrated, useBoardLaneStore.getInitialState());

    expect(merged.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(merged.placementByThreadKey).toEqual({
      "env-a:shaping": "in-progress",
      "env-a:done": "review",
    });
  });

  it.each([
    { lifecycleLanes: [] },
    {
      lifecycleLanes: [
        {
          id: "settled",
          name: "Settled",
          description: "Sessions you want to keep parked as settled on this board",
          order: 3,
        },
        {
          id: "snoozed",
          name: "Snoozed",
          description: "Sessions you want to revisit later on this board",
          order: 4,
        },
      ],
    },
  ])(
    "upgrades the untouched legacy defaults to the traditional lifecycle",
    ({ lifecycleLanes }) => {
      const persistApi = useBoardLaneStore.persist as unknown as {
        getOptions: () => {
          migrate: (persistedState: unknown, version: number) => unknown;
          merge: (
            persistedState: unknown,
            currentState: ReturnType<typeof useBoardLaneStore.getState>,
          ) => ReturnType<typeof useBoardLaneStore.getState>;
        };
      };
      const legacyLanes = [
        {
          id: "triage",
          name: "Triage",
          description: "New and unplaced sessions start here until you file them elsewhere",
          order: -1,
        },
        {
          id: "shaping",
          name: "Grilling / shaping",
          description: "Working out what this actually is",
          order: 0,
        },
        {
          id: "ready",
          name: "Ready",
          description: "Groomed and ready to pick up",
          order: 1,
        },
        {
          id: "done",
          name: "Done",
          description: "Finished work you want to keep visible on this board",
          order: 2,
        },
        ...lifecycleLanes,
      ];
      const migrated = persistApi.getOptions().migrate(
        {
          lanes: legacyLanes,
          placementByThreadKey: {
            "env-a:shaping": "shaping",
            "env-a:done": "done",
          },
          laneEntryByThreadKey: {
            "env-a:shaping": {
              laneId: "shaping",
              enteredAt: "2026-01-01T00:00:00.000Z",
            },
            "env-a:done": {
              laneId: "done",
              enteredAt: "2026-01-02T00:00:00.000Z",
            },
          },
          orderByLaneId: {
            shaping: ["env-a:shaping"],
            done: ["env-a:done"],
          },
          byLaneColumnKey: {
            shaping: { widthPx: 410 },
            done: { widthPx: 430 },
          },
        },
        3,
      );
      const merged = persistApi.getOptions().merge(migrated, useBoardLaneStore.getInitialState());

      expect(merged.lanes).toEqual(DEFAULT_BOARD_LANES);
      expect(merged.placementByThreadKey).toEqual({
        "env-a:shaping": "in-progress",
        "env-a:done": "review",
      });
      expect(merged.laneEntryByThreadKey).toEqual({
        "env-a:shaping": {
          laneId: "in-progress",
          enteredAt: "2026-01-01T00:00:00.000Z",
        },
        "env-a:done": {
          laneId: "review",
          enteredAt: "2026-01-02T00:00:00.000Z",
        },
      });
      expect(merged.orderByLaneId).toEqual({
        "in-progress": ["env-a:shaping"],
        review: ["env-a:done"],
      });
      expect(merged.byLaneColumnKey).toEqual({
        "in-progress": { widthPx: 410 },
        review: { widthPx: 430 },
      });
    },
  );

  it("does not replace a customized legacy lane registry", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const merged = persistApi.getOptions().merge(
      {
        lanes: [
          {
            id: "triage",
            name: "Triage",
            description: "New and unplaced sessions start here until you file them elsewhere",
            order: -1,
          },
          {
            id: "shaping",
            name: "Discovery",
            description: "Working out what this actually is",
            order: 0,
          },
          {
            id: "ready",
            name: "Ready",
            description: "Groomed and ready to pick up",
            order: 1,
          },
          {
            id: "done",
            name: "Done",
            description: "Finished work you want to keep visible on this board",
            order: 2,
          },
        ],
      },
      useBoardLaneStore.getInitialState(),
    );

    expect(merged.lanes.map((lane) => lane.id)).toEqual([
      "triage",
      "shaping",
      "ready",
      "done",
      "snoozed",
      "settled",
    ]);
    expect(merged.lanes.find((lane) => lane.id === "shaping")?.name).toBe("Discovery");
  });

  it("normalizes persisted lifecycle collapse state", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const merged = persistApi.getOptions().merge(
      {
        lanes: DEFAULT_BOARD_LANES,
        collapsedLifecycleLaneIds: ["settled", "triage", "settled", "snoozed", 1],
      },
      useBoardLaneStore.getInitialState(),
    );

    expect(merged.collapsedLifecycleLaneIds).toEqual(["settled", "snoozed"]);
  });

  it("clamps malformed persisted widths and defaults absent local lane data", () => {
    const persistApi = useBoardLaneStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useBoardLaneStore.getState>,
        ) => ReturnType<typeof useBoardLaneStore.getState>;
      };
    };
    const mergedState = persistApi
      .getOptions()
      .merge(
        { byLaneColumnKey: { [laneB]: { widthPx: BOARD_LANE_MAX_WIDTH + 1000 } } },
        useBoardLaneStore.getInitialState(),
      );

    expect(mergedState.lanes).toEqual(DEFAULT_BOARD_LANES);
    expect(mergedState.byLaneColumnKey).toEqual({ [laneB]: { widthPx: BOARD_LANE_MAX_WIDTH } });
    expect(selectBoardLaneWidth(mergedState.byLaneColumnKey, "missing")).toBe(
      BOARD_LANE_DEFAULT_WIDTH,
    );
  });
});
