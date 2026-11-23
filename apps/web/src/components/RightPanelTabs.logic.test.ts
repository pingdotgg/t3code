import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import {
  changesNovel,
  clampTerminalDrawerHeight,
  currentTerminalClaims,
  latestTurnChangeTotals,
  nextUnseenRightPanelGroups,
  reconcileMountedTerminalThreads,
  reconcileTerminalSurfaceIds,
  rightPanelGroupOf,
  rightPanelGroupTarget,
  terminalDrawerStatus,
  terminalSurfaceMount,
  TERMINAL_DRAWER_MIN_HEIGHT,
  visibleRightPanelToolGroups,
} from "./RightPanelTabs.logic";

const diff: RightPanelSurface = { id: "diff", kind: "diff" };
const firstTerminal = {
  id: "terminal:a",
  kind: "terminal",
  terminalIds: ["a"],
  activeTerminalId: "a",
} as unknown as RightPanelSurface;
const browser: RightPanelSurface = { id: "browser:tab", kind: "preview", resourceId: "tab" };
const files = { id: "files", kind: "files" } as unknown as RightPanelSurface;

function summary(
  checkpointTurnCount: number,
  fileCount: number,
  filesTotal?: number,
): ThreadCheckpointSummary {
  return {
    checkpointTurnCount,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `f${index}`,
      kind: "modified",
      additions: 1,
      deletions: 0,
    })),
    ...(filesTotal === undefined
      ? {}
      : { filesTotal: { count: filesTotal, additions: 0, deletions: 0 } }),
  } as unknown as ThreadCheckpointSummary;
}

describe("latestTurnChangeTotals", () => {
  it("totals the files of the highest turn, whatever the order", () => {
    expect(latestTurnChangeTotals([summary(2, 3), summary(1, 7)])).toEqual({
      turnCount: 2,
      count: 3,
      additions: 3,
      deletions: 0,
    });
    expect(latestTurnChangeTotals([summary(1, 7), summary(2, 3)])?.turnCount).toBe(2);
  });

  it("uses the server total when the file list is only a prefix", () => {
    expect(latestTurnChangeTotals([summary(1, 2, 40)])).toEqual({
      turnCount: 1,
      count: 40,
      additions: 0,
      deletions: 0,
    });
  });

  it("has no totals before the first turn", () => {
    expect(latestTurnChangeTotals([])).toBeNull();
  });
});

const file = {
  id: "file:src/a.ts",
  kind: "file",
  relativePath: "src/a.ts",
  revealLine: null,
  revealRequestId: 1,
} as unknown as RightPanelSurface;
const secondBrowser: RightPanelSurface = {
  id: "browser:tab2",
  kind: "preview",
  resourceId: "tab2",
};
const device = { id: "device", kind: "device" } as unknown as RightPanelSurface;
const pullRequest = {
  id: "pull-request:p:r:1",
  kind: "pull-request",
} as unknown as RightPanelSurface;

describe("right panel groups", () => {
  it("maps every surface kind to its rail group", () => {
    const table: Array<[RightPanelSurface, string]> = [
      [diff, "changes"],
      [browser, "browser"],
      [files, "files"],
      [file, "files"],
      [{ id: "pull-requests", kind: "pull-requests" }, "reviews"],
      [pullRequest, "reviews"],
      [{ id: "issue:x", kind: "issue" } as unknown as RightPanelSurface, "reviews"],
      [device, "devices"],
      [{ id: "thread:t", kind: "thread" } as unknown as RightPanelSurface, "threads"],
      [{ id: "linked-thread:x", kind: "linked-thread" } as unknown as RightPanelSurface, "threads"],
      [firstTerminal, "terminal"],
    ];
    for (const [surface, group] of table) expect(rightPanelGroupOf(surface)).toBe(group);
  });

  it("keeps the active surface when it belongs to the group, else the newest of the group", () => {
    const surfaces = [diff, browser, files, secondBrowser, file];
    expect(rightPanelGroupTarget(surfaces, "browser:tab", "browser")).toBe(browser);
    expect(rightPanelGroupTarget(surfaces, "diff", "browser")).toBe(secondBrowser);
    expect(rightPanelGroupTarget(surfaces, null, "changes")).toBe(diff);
    expect(rightPanelGroupTarget(surfaces, "diff", "files")).toBe(file);
  });

  it("asks for a new surface when the group has none", () => {
    expect(rightPanelGroupTarget([diff, files], "diff", "browser")).toBeNull();
    expect(rightPanelGroupTarget([diff, firstTerminal], "diff", "devices")).toBeNull();
  });

  it("always shows changes, browser and files; others need availability or an open surface", () => {
    const none = { reviews: false, devices: false, threads: false };
    expect(visibleRightPanelToolGroups({ surfaces: [], available: none })).toEqual([
      "changes",
      "browser",
      "files",
    ]);
    expect(
      visibleRightPanelToolGroups({
        surfaces: [device],
        available: { reviews: true, devices: false, threads: false },
      }),
    ).toEqual(["changes", "browser", "files", "reviews", "devices"]);
    expect(
      visibleRightPanelToolGroups({
        surfaces: [],
        available: { reviews: false, devices: false, threads: true },
      }),
    ).toEqual(["changes", "browser", "files", "threads"]);
  });
});

describe("unseen groups", () => {
  it("marks the group of a surface added while another group is active", () => {
    expect(
      nextUnseenRightPanelGroups({
        before: [diff],
        after: { isOpen: true, activeSurfaceId: "diff", surfaces: [diff, pullRequest] },
        drawerOpen: false,
        unseen: [],
      }),
    ).toEqual(["reviews"]);
  });

  it("does not mark the active group, and clears a group once it is visible", () => {
    expect(
      nextUnseenRightPanelGroups({
        before: [diff],
        after: { isOpen: true, activeSurfaceId: "browser:tab", surfaces: [diff, browser] },
        drawerOpen: false,
        unseen: [],
      }),
    ).toEqual([]);
    expect(
      nextUnseenRightPanelGroups({
        before: [diff, pullRequest],
        after: { isOpen: true, activeSurfaceId: pullRequest.id, surfaces: [diff, pullRequest] },
        drawerOpen: false,
        unseen: ["reviews", "browser"],
      }),
    ).toEqual(["browser"]);
  });

  it("marks terminal while the drawer or the panel is closed, clears it when the drawer shows", () => {
    expect(
      nextUnseenRightPanelGroups({
        before: [diff],
        after: { isOpen: true, activeSurfaceId: "diff", surfaces: [diff, firstTerminal] },
        drawerOpen: false,
        unseen: [],
      }),
    ).toEqual(["terminal"]);
    expect(
      nextUnseenRightPanelGroups({
        before: [diff],
        after: { isOpen: false, activeSurfaceId: "diff", surfaces: [diff, firstTerminal] },
        drawerOpen: true,
        unseen: [],
      }),
    ).toEqual(["terminal"]);
    expect(
      nextUnseenRightPanelGroups({
        before: [diff, firstTerminal],
        after: { isOpen: true, activeSurfaceId: "diff", surfaces: [diff, firstTerminal] },
        drawerOpen: true,
        unseen: ["terminal"],
      }),
    ).toEqual([]);
  });

  it("returns the same array when nothing changes", () => {
    const unseen = ["reviews"] as const;
    expect(
      nextUnseenRightPanelGroups({
        before: [diff],
        after: { isOpen: true, activeSurfaceId: "diff", surfaces: [diff] },
        drawerOpen: false,
        unseen,
      }),
    ).toBe(unseen);
  });
});

describe("changes novelty", () => {
  const latest = { turnCount: 3, count: 2 };

  it("has no dot before the open panel seeds a seen turn", () => {
    expect(changesNovel({ latest, seenTurnCount: undefined, changesVisible: false })).toBe(false);
  });

  it("lights for a newer turn that changed files while Changes is hidden", () => {
    expect(changesNovel({ latest, seenTurnCount: 2, changesVisible: false })).toBe(true);
  });

  it("stays off for a newer turn that changed no files", () => {
    expect(
      changesNovel({ latest: { turnCount: 3, count: 0 }, seenTurnCount: 2, changesVisible: false }),
    ).toBe(false);
  });

  it("stays off while Changes is visible", () => {
    expect(changesNovel({ latest, seenTurnCount: 2, changesVisible: true })).toBe(false);
  });
});

describe("terminal adoption", () => {
  const snapshot = "manager-1";

  it("adopts every server terminal no surface owns, in server order", () => {
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(["b"]),
        serverIds: ["c", "b", "a"],
        previous: undefined,
        snapshotId: snapshot,
        closingIds: [],
      }),
    ).toEqual({ adopt: ["c", "a"], drop: [] });
  });

  it("skips terminals that are closing", () => {
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(),
        serverIds: ["a", "b"],
        previous: undefined,
        snapshotId: snapshot,
        closingIds: ["a"],
      }).adopt,
    ).toEqual(["b"]);
  });

  it("drops only ids the server listed before and no longer lists", () => {
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(["a", "b", "local"]),
        serverIds: ["a"],
        previous: { ids: ["a", "b"], snapshotId: snapshot },
        snapshotId: snapshot,
        closingIds: [],
      }),
    ).toEqual({ adopt: [], drop: ["b"] });
  });

  it("never drops on the first observation or when the snapshot changes", () => {
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(["a"]),
        serverIds: [],
        previous: undefined,
        snapshotId: snapshot,
        closingIds: [],
      }).drop,
    ).toEqual([]);
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(["a"]),
        serverIds: [],
        previous: { ids: ["a"], snapshotId: snapshot },
        snapshotId: "manager-2",
        closingIds: [],
      }).drop,
    ).toEqual([]);
  });

  it("adopts a session created later within the same snapshot", () => {
    expect(
      reconcileTerminalSurfaceIds({
        ownedIds: new Set(["a"]),
        serverIds: ["a", "setup"],
        previous: { ids: ["a"], snapshotId: snapshot },
        snapshotId: snapshot,
        closingIds: [],
      }),
    ).toEqual({ adopt: ["setup"], drop: [] });
  });
});

describe("terminal mounting", () => {
  it("mounts only ids the server lists or this client opened, and waits while the list is unknown", () => {
    expect(
      terminalSurfaceMount({ terminalIds: ["a", "b"], serverIds: ["b"], claimedIds: [] }),
    ).toEqual({ kind: "mount", terminalIds: ["b"] });
    expect(
      terminalSurfaceMount({ terminalIds: ["a"], serverIds: null, claimedIds: ["a"] }),
    ).toEqual({ kind: "mount", terminalIds: ["a"] });
    expect(terminalSurfaceMount({ terminalIds: ["a"], serverIds: null, claimedIds: [] })).toEqual({
      kind: "pending",
    });
    // A saved sub-tab the server no longer lists, after a restart: attaching would start a shell.
    expect(terminalSurfaceMount({ terminalIds: ["a"], serverIds: [], claimedIds: [] })).toEqual({
      kind: "ended",
    });
  });

  it("ignores claims made before the server restarted, until reconcile clears them", () => {
    const claimedIds = ["a"];
    expect(
      currentTerminalClaims({ claimedIds, observedSnapshotId: "m1", serverSnapshotId: "m2" }),
    ).toEqual([]);
    expect(
      currentTerminalClaims({ claimedIds, observedSnapshotId: "m1", serverSnapshotId: "m1" }),
    ).toEqual(["a"]);
    expect(
      currentTerminalClaims({ claimedIds, observedSnapshotId: undefined, serverSnapshotId: "m2" }),
    ).toEqual(["a"]);
  });
});

describe("mounted terminal threads", () => {
  const open = new Set(["a", "b", "c", "d"]);

  it("mounts the active thread once its drawer shows and keeps it through a collapse", () => {
    const reconcile = (current: string[], activeShowing: boolean) =>
      reconcileMountedTerminalThreads({ current, panelOpen: open, active: "a", activeShowing });
    expect(reconcile([], false)).toEqual([]);
    expect(reconcile([], true)).toEqual(["a"]);
    expect(reconcile(["a"], false)).toEqual(["a"]);
  });

  it("keeps recently shown threads whose panel is open, most recent last, up to the cap", () => {
    expect(
      reconcileMountedTerminalThreads({
        current: ["a", "b", "c"],
        panelOpen: open,
        active: "a",
        activeShowing: true,
      }),
    ).toEqual(["b", "c", "a"]);
    expect(
      reconcileMountedTerminalThreads({
        current: ["a", "b", "c"],
        panelOpen: new Set(["a", "c", "d"]),
        active: "d",
        activeShowing: true,
        maxHidden: 1,
      }),
    ).toEqual(["c", "d"]);
  });
});

function terminalSummary(
  overrides: Partial<Pick<TerminalSummary, "status" | "exitCode" | "hasRunningSubprocess">>,
): TerminalSummary {
  return {
    threadId: "t",
    terminalId: "a",
    cwd: "/",
    worktreePath: null,
    status: "running",
    pid: 1,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("terminal drawer status", () => {
  it.each([
    ["running with a subprocess", { status: "running", hasRunningSubprocess: true }, "running"],
    ["exited 0", { status: "exited", exitCode: 0 }, "ok"],
    ["exited 1", { status: "exited", exitCode: 1 }, "failed"],
    ["error", { status: "error" }, "failed"],
    ["starting without a subprocess", { status: "starting" }, null],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(terminalDrawerStatus(terminalSummary(overrides))).toBe(expected);
  });

  it("has no status without a summary", () => {
    expect(terminalDrawerStatus(null)).toBeNull();
  });
});

it("clamps drawer height to the container and falls back to the default", () => {
  expect(clampTerminalDrawerHeight(2000, 600)).toBe(480);
  expect(clampTerminalDrawerHeight(10, 600)).toBe(TERMINAL_DRAWER_MIN_HEIGHT);
  expect(clampTerminalDrawerHeight(300, 600)).toBe(300);
  expect(clampTerminalDrawerHeight(Number.NaN, 600)).toBe(280);
});
