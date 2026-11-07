import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { DEFAULT_CLIENT_SETTINGS, type SidebarVariant } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarLayout } from "./sidebarLayout";
import {
  arrangeDetailedFolder,
  arrangeStableRows,
  detailedFolderShows,
  rowAttention,
  threadsWaitingOnYou,
  variantRowStyle,
  workerSummary,
  workersByParent,
} from "./sidebarVariant.logic";

const shell = (
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
): EnvironmentThreadShell =>
  ({
    id,
    environmentId: "environment-a",
    projectId: "project-a",
    createdAt,
    archivedAt: null,
    pinnedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    runtime: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const worker = (id: string, parent: string, overrides: Record<string, unknown> = {}) =>
  shell(id, "2026-01-01T00:00:00.000Z", {
    lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
    ...overrides,
  });

const arrange = (input: Partial<Parameters<typeof arrangeDetailedFolder>[0]>) =>
  arrangeDetailedFolder({
    collapsed: false,
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
    workers: new Map(),
    workerFold: new Map(),
    parkedOpen: false,
    routeRowKey: null,
    routeThreadKey: null,
    ...input,
  });

const ids = (result: ReturnType<typeof arrange>) =>
  result.items.flatMap((item): string[] =>
    item.kind === "thread" ? [item.thread.id] : [item.kind],
  );

describe("resolveSidebarLayout", () => {
  const variants: readonly SidebarVariant[] = ["default", "detailed", "slim"];
  const flags = [false, true];

  it("gives every combination of the sidebar settings one consistent layout", () => {
    for (const sidebarVariant of variants) {
      for (const boringSidebarEnabled of flags) {
        for (const boringSidebarMultilineRows of flags) {
          for (const legacySidebarEnabled of flags) {
            for (const sidebarWorkingShelfEnabled of flags) {
              const layout = resolveSidebarLayout({
                sidebarVariant,
                boringSidebarEnabled,
                boringSidebarMultilineRows,
                legacySidebarEnabled,
                sidebarWorkingShelfEnabled,
              });
              const boring = boringSidebarEnabled || legacySidebarEnabled;
              expect(layout.locked).toBe(sidebarVariant !== "default");
              expect(layout.folders).toBe(sidebarVariant !== "default" || boring);
              expect(layout.workingSection).toBe(
                sidebarVariant === "default" && !boring && sidebarWorkingShelfEnabled,
              );
              expect(layout.twoLineRows).toBe(
                sidebarVariant === "default"
                  ? boringSidebarMultilineRows
                  : sidebarVariant === "detailed",
              );
              expect(layout.folders && layout.workingSection).toBe(false);
            }
          }
        }
      }
    }
  });

  it("matches what users have today when nothing is set", () => {
    expect(resolveSidebarLayout(DEFAULT_CLIENT_SETTINGS)).toEqual({
      locked: false,
      folders: false,
      workingSection: true,
      twoLineRows: false,
    });
  });
});

describe("variantRowStyle", () => {
  it("leaves every row to T3 under Default", () => {
    for (const section of ["pinned", "active", "working", "snoozed", "settled"] as const) {
      expect(variantRowStyle("default", section, true)).toBeNull();
      expect(variantRowStyle("default", section, false)).toBeNull();
    }
  });

  it("styles pinned rows in Slim and leaves its shelves to T3", () => {
    expect(variantRowStyle("slim", "active", true)).toBe("folder-slim");
    expect(variantRowStyle("slim", "pinned", false)).toBe("folder-slim");
    expect(variantRowStyle("slim", "settled", false)).toBeNull();
    expect(variantRowStyle("detailed", "settled", true)).toBe("folder-detailed");
  });
});

describe("detailedFolderShows", () => {
  it("keeps an empty folder only when the sidebar's predicate does", () => {
    expect(detailedFolderShows({ active: [], settled: [] }, true)).toBe(true);
    expect(detailedFolderShows({ active: [], settled: [] }, false)).toBe(false);
    expect(detailedFolderShows({ active: [], settled: ["thread"] }, false)).toBe(true);
  });
});

describe("rowAttention", () => {
  it("marks asks, failures and unseen finishes only", () => {
    expect(rowAttention("approval", false)).toBe("warning");
    expect(rowAttention("limited", false)).toBe("warning");
    expect(rowAttention("input", false)).toBe("input");
    expect(rowAttention("request", false)).toBe("guest");
    expect(rowAttention("failed", true)).toBe("error");
    expect(rowAttention("ready", true)).toBe("success");
    expect(rowAttention("ready", false)).toBeUndefined();
    expect(rowAttention("working", true)).toBeUndefined();
  });
});

describe("placement", () => {
  it("keeps every row in its slot when only its state changes", () => {
    const before = [
      shell("a", "2026-01-01T00:00:00.000Z"),
      shell("b", "2026-01-03T00:00:00.000Z", { hasPendingApprovals: true }),
      shell("c", "2026-01-02T00:00:00.000Z"),
    ];
    const after = before.map((thread) =>
      shell(thread.id, thread.createdAt, {
        hasPendingUserInput: true,
        runtime: { status: "idle" },
      }),
    );
    expect(arrangeStableRows(after).map((thread) => thread.id)).toEqual(
      arrangeStableRows(before).map((thread) => thread.id),
    );
    expect(arrangeStableRows(before).map((thread) => thread.id)).toEqual(["b", "c", "a"]);
  });

  it("puts pinned threads first, newest first inside each part", () => {
    const threads = [
      shell("old", "2026-01-01T00:00:00.000Z"),
      shell("new", "2026-01-05T00:00:00.000Z"),
      shell("pin", "2026-01-02T00:00:00.000Z", { pinnedAt: "2026-01-09T00:00:00.000Z" }),
    ];
    expect(arrangeStableRows(threads).map((thread) => thread.id)).toEqual(["pin", "new", "old"]);
  });

  it("parks snoozed and settled threads behind one row in their folder", () => {
    const settled = [shell("s1", "2026-01-01T00:00:00.000Z")];
    const snoozed = [shell("z1", "2026-01-01T00:00:00.000Z")];
    const closed = arrange({ snoozed, settled });
    expect(ids(closed)).toEqual(["parked"]);
    expect(closed.items[0]).toMatchObject({ label: "1 snoozed · 1 settled", open: false });
    expect(ids(arrange({ snoozed, settled, parkedOpen: true }))).toEqual(["parked", "z1", "s1"]);
  });

  it("still shows the open thread in a closed folder or parked group", () => {
    const active = [shell("a", "2026-01-01T00:00:00.000Z"), shell("b", "2026-01-02T00:00:00.000Z")];
    const key = "environment-a:a";
    const closed = arrange({ active, collapsed: true, routeRowKey: key });
    expect(ids(closed)).toEqual(["a"]);
    expect(closed.hiddenThreads.map((thread) => thread.id)).toEqual(["b"]);
    const settled = [shell("s", "2026-01-01T00:00:00.000Z")];
    expect(ids(arrange({ settled, routeRowKey: "environment-a:s" }))).toEqual(["parked", "s"]);
  });
});

describe("workers", () => {
  const parent = shell("p", "2026-01-01T00:00:00.000Z");
  const quiet = worker("w1", "p");
  const asking = worker("w2", "p", { hasPendingApprovals: true });

  it("folds workers until one needs the user, and honors a manual choice", () => {
    const folded = workersByParent([parent, quiet]);
    const closed = arrange({ active: [parent], workers: folded });
    expect(ids(closed)).toEqual(["p"]);
    expect(closed.items[0]).toMatchObject({ workersOpen: false });
    const needs = workersByParent([parent, quiet, asking]);
    const open = arrange({ active: [parent], workers: needs });
    expect(ids(open)).toEqual(["p", "w1", "w2"]);
    expect(open.items[0]).toMatchObject({ workersOpen: true });
    expect(open.items[1]).toMatchObject({ nested: true, lastNested: false });
    expect(open.items[2]).toMatchObject({ nested: true, lastNested: true });
    expect(
      ids(
        arrange({
          active: [parent],
          workers: needs,
          workerFold: new Map([["environment-a:p", false]]),
        }),
      ),
    ).toEqual(["p"]);
  });

  it("shows an open worker under its parent while the row is folded", () => {
    const workers = workersByParent([parent, quiet]);
    expect(ids(arrange({ active: [parent], workers, routeThreadKey: "environment-a:w1" }))).toEqual(
      ["p", "w1"],
    );
  });

  it("counts workers and how many share the most urgent state", () => {
    const running = worker("w3", "p", { runtime: { status: "running" } });
    expect(workerSummary([quiet])).toBe("1 worker");
    expect(workerSummary([quiet, running])).toBe("2 workers · 1 working");
    expect(workerSummary([running, asking, quiet])).toBe("3 workers · 1 approval");
  });

  it("counts a thread as waiting only when it asks itself", () => {
    const raised = shell("r", "2026-01-01T00:00:00.000Z", { pendingSubagentRequest: "approval" });
    const archived = shell("x", "2026-01-01T00:00:00.000Z", {
      hasPendingApprovals: true,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const other = shell("o", "2026-01-01T00:00:00.000Z", {
      hasPendingUserInput: true,
      projectId: "project-b",
    });
    const threads = [raised, archived, asking, other];
    expect(threadsWaitingOnYou(threads, null).map((thread) => thread.id)).toEqual(["w2", "o"]);
    expect(
      threadsWaitingOnYou(threads, new Set(["environment-a:project-a"])).map((thread) => thread.id),
    ).toEqual(["w2"]);
  });
});
