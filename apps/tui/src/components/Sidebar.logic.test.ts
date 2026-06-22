import { describe, expect, it } from "bun:test";

import { DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT } from "@t3tools/contracts";
import type { OrchestrationShellSnapshot } from "../connection.ts";
import {
  buildRows,
  type Row,
  type Selection,
  selectionEquals,
  visibleThreadsForProject,
} from "./Sidebar.logic.ts";

const shell = (
  projects: ReadonlyArray<{ id: string; title: string }>,
  threads: ReadonlyArray<{ id: string; projectId: string; title?: string }>,
): OrchestrationShellSnapshot => ({ projects, threads }) as unknown as OrchestrationShellSnapshot;

const threadRow = (id: string): Row => ({ kind: "thread", id, thread: {} as never });

describe("selectionEquals", () => {
  it("Given a project selection and a matching project row, then true", () => {
    const selection: Selection = { kind: "project", id: "p1" };
    const row: Row = { kind: "project", id: "p1", title: "P1", count: 0, status: null, expanded: false };
    expect(selectionEquals(selection, row)).toBe(true);
  });

  it("Given a null selection, then false", () => {
    expect(selectionEquals(null, threadRow("t1"))).toBe(false);
  });

  it("Given the same id but different kind, then false", () => {
    expect(selectionEquals({ kind: "project", id: "x" }, threadRow("x"))).toBe(false);
  });
});

describe("visibleThreadsForProject", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}` })) as never[];

  it("Given loadedInFull, then all threads are visible with 0 hidden", () => {
    const { visible, hidden } = visibleThreadsForProject(many(20), true, null);
    expect(visible).toHaveLength(20);
    expect(hidden).toBe(0);
  });

  it("Given more than the preview count, then it shows the preview and reports the rest hidden", () => {
    const total = DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT + 9;
    const { visible, hidden } = visibleThreadsForProject(many(total), false, null);
    expect(visible).toHaveLength(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT);
    expect(hidden).toBe(9);
  });

  it("Given the selected thread is past the preview, then it is kept visible", () => {
    const total = DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT + 5;
    const selectedId = `t${total - 1}`;
    const { visible, hidden } = visibleThreadsForProject(many(total), false, selectedId);
    expect(visible.some((t) => (t as { id: string }).id === selectedId)).toBe(true);
    expect(visible).toHaveLength(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT + 1);
    expect(hidden).toBe(total - visible.length);
  });
});

describe("buildRows", () => {
  it("Given a null shell, then no rows", () => {
    expect(buildRows(null, new Set(), new Set(), null)).toEqual([]);
  });

  it("Given collapsed projects, then only project rows (threads hidden)", () => {
    const rows = buildRows(
      shell([{ id: "p1", title: "P1" }], [{ id: "t1", projectId: "p1" }]),
      new Set(),
      new Set(),
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "project", id: "p1", count: 1, expanded: false });
  });

  it("Given an expanded project, then its threads follow the project row", () => {
    const rows = buildRows(
      shell([{ id: "p1", title: "P1" }], [
        { id: "t1", projectId: "p1" },
        { id: "t2", projectId: "p1" },
      ]),
      new Set(["p1"]),
      new Set(["p1"]),
      null,
    );
    expect(rows.map((r) => r.kind)).toEqual(["project", "thread", "thread"]);
  });

  it("Given a project with no threads, then it still appears (matches the project count)", () => {
    const rows = buildRows(shell([{ id: "empty", title: "Empty" }], []), new Set(), new Set(), null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "project", id: "empty", count: 0 });
  });
});

describe("buildRows — filter (^F)", () => {
  const filterShell = () =>
    shell(
      [
        { id: "p1", title: "Alpha" },
        { id: "p2", title: "Beta" },
      ],
      [
        { id: "t1", projectId: "p1", title: "fix login bug" },
        { id: "t2", projectId: "p1", title: "add dark mode" },
        { id: "t3", projectId: "p2", title: "login rate limit" },
      ],
    );

  it("Given a filter matching thread titles, then only matching threads (and their projects) show", () => {
    const rows = buildRows(filterShell(), new Set(), new Set(), null, "login");
    expect(rows.map((r) => r.kind)).toEqual(["project", "thread", "project", "thread"]);
    const threadIds = rows.filter((r) => r.kind === "thread").map((r) => r.id);
    expect(threadIds).toEqual(["t1", "t3"]);
  });

  it("Given a filter with no match in a project, then that project is omitted", () => {
    const rows = buildRows(filterShell(), new Set(), new Set(), null, "dark");
    expect(rows.map((r) => r.id)).toEqual(["p1", "t2"]);
  });

  it("Given a filter is case-insensitive and trimmed, then it still matches", () => {
    const rows = buildRows(filterShell(), new Set(), new Set(), null, "  LOGIN ");
    expect(rows.filter((r) => r.kind === "thread")).toHaveLength(2);
  });

  it("Given a filter matching a project title, then all of its threads show", () => {
    const rows = buildRows(filterShell(), new Set(), new Set(), null, "alpha");
    expect(rows.map((r) => r.id)).toEqual(["p1", "t1", "t2"]);
  });

  it("Given a filtered project, then it auto-expands with no 'show more' row", () => {
    const rows = buildRows(filterShell(), new Set(), new Set(), null, "login");
    expect(rows.some((r) => r.kind === "more")).toBe(false);
    expect(rows.find((r) => r.kind === "project")).toMatchObject({ expanded: true });
  });
});

describe("buildRows — project ordering", () => {
  const ts = (iso: string) => iso;
  const richShell = () =>
    ({
      projects: [
        { id: "old", title: "Old", createdAt: ts("2026-01-01T00:00:00.000Z"), updatedAt: ts("2026-01-01T00:00:00.000Z") },
        { id: "new", title: "New", createdAt: ts("2026-01-01T00:00:00.000Z"), updatedAt: ts("2026-01-01T00:00:00.000Z") },
        { id: "empty", title: "Empty", createdAt: ts("2026-03-01T00:00:00.000Z"), updatedAt: ts("2026-03-01T00:00:00.000Z") },
      ],
      threads: [
        { id: "t-old", projectId: "old", title: "t", updatedAt: ts("2026-02-01T00:00:00.000Z") },
        { id: "t-new", projectId: "new", title: "t", updatedAt: ts("2026-04-01T00:00:00.000Z") },
      ],
    }) as unknown as OrchestrationShellSnapshot;

  it("Given projects, then they sort by their most recent thread, newest first", () => {
    const rows = buildRows(richShell(), new Set(), new Set(), null);
    const projectIds = rows.filter((r) => r.kind === "project").map((r) => r.id);
    // new (thread @ Apr) > empty (no threads, project @ Mar) > old (thread @ Feb).
    expect(projectIds).toEqual(["new", "empty", "old"]);
  });

  it("Given equal activity, then it breaks ties by title", () => {
    const flat = {
      projects: [
        { id: "b", title: "Bravo", createdAt: ts("2026-01-01T00:00:00.000Z"), updatedAt: ts("2026-05-01T00:00:00.000Z") },
        { id: "a", title: "Alpha", createdAt: ts("2026-01-01T00:00:00.000Z"), updatedAt: ts("2026-05-01T00:00:00.000Z") },
      ],
      threads: [],
    } as unknown as OrchestrationShellSnapshot;
    const projectIds = buildRows(flat, new Set(), new Set(), null)
      .filter((r) => r.kind === "project")
      .map((r) => r.id);
    expect(projectIds).toEqual(["a", "b"]);
  });
});
