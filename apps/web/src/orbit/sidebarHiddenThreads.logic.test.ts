import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import {
  isSidebarHiddenThread,
  NO_SIDEBAR_HIDDEN_MARKS,
  planSidebarPeek,
  sidebarHiddenMarks,
  sidebarSettledCount,
  unresolvedSidebarHiddenCount,
  withoutSidebarHiddenProjects,
} from "./sidebarHiddenThreads.logic";

const thread = (environmentId: string, id: string, projectId = "p1", archivedAt = null) => ({
  environmentId,
  id,
  projectId,
  archivedAt,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
});
type Row = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];
const visible = (threads: ReturnType<typeof thread>[], marks = NO_SIDEBAR_HIDDEN_MARKS) =>
  filterSidebarV2VisibleThreads(threads as unknown as Row[], null, new Set(), marks).map(
    (row) => `${row.environmentId}:${row.id}`,
  );
const group = (...members: [string, string][]) => ({
  memberProjects: members.map(([environmentId, id]) => ({ environmentId, id })),
});

describe("sidebar hidden marks", () => {
  it("hides a peeked target and its new environment's siblings, but not rows listed before", () => {
    // The local thread was listed before the peek; the clone environment is new on this device.
    expect(planSidebarPeek({ targetListed: false, environmentSurfaced: true })).toEqual({
      hideTarget: true,
      holdEnvironment: true,
    });
    const marks = sidebarHiddenMarks({
      agreed: [],
      ops: new Map([["clone:target", { intent: "hide" as const }]]),
      attempts: [],
      unhydrated: ["clone"],
    });
    const threads = [
      thread("local", "mine"),
      thread("clone", "target"),
      thread("clone", "sibling"),
    ];
    expect(visible(threads, marks)).toEqual(["local:mine"]);
    // Its projects stay out of the list and the scope menu too, also an empty one.
    const groups = [group(["local", "p1"]), group(["clone", "p1"]), group(["clone", "empty"])];
    const unloaded = (project: { environmentId: string }) =>
      project.environmentId === "clone" ? 1 : 0;
    expect(
      withoutSidebarHiddenProjects(groups, threads, marks, { unloaded, rows: () => null }),
    ).toEqual({ groups: [groups[0]], unresolved: [] });
  });

  it("keeps a project only once an unloaded older thread provably shows", () => {
    const marks = sidebarHiddenMarks({
      agreed: ["local:a-loaded", "local:b-loaded", "local:b-older"],
      ops: new Map(),
      attempts: [],
      unhydrated: [],
    });
    const threads = [thread("local", "a-loaded", "a"), thread("local", "b-loaded", "b")];
    const groups = [group(["local", "a"]), group(["local", "b"])];
    const older = (
      counts: Record<string, number>,
      rows: Array<{ id: string; projectId: string }> | null,
    ) => ({
      unloaded: (project: { readonly id: string }) => counts[project.id] ?? 0,
      rows: () => rows,
    });
    // One unloaded older thread each, and one hidden mark nobody holds: either may be it.
    expect(
      withoutSidebarHiddenProjects(groups, threads, marks, older({ a: 1, b: 1 }, null)),
    ).toEqual({ groups: [], unresolved: ["local"] });
    // More unloaded than unresolved marks: a shows without a read.
    expect(
      withoutSidebarHiddenProjects(groups, threads, marks, older({ a: 2, b: 1 }, null)),
    ).toEqual({ groups: [groups[0]], unresolved: ["local"] });
    // The full read places b-older in b: a's older thread shows, b's is hidden.
    const rows = [
      { id: "a-older", projectId: "a" },
      { id: "b-older", projectId: "b" },
    ];
    expect(
      withoutSidebarHiddenProjects(groups, threads, marks, older({ a: 1, b: 1 }, rows)),
    ).toEqual({ groups: [groups[0]], unresolved: [] });
    // The inventory sees b's older thread archived or removed before the count catches up.
    // Only a visible inventory row can now qualify b, even while the old count reports two.
    expect(
      withoutSidebarHiddenProjects(groups, threads, marks, older({ a: 1, b: 2 }, rows)),
    ).toEqual({ groups: [groups[0]], unresolved: [] });
    // Once a's older thread loaded and is hidden too, a goes.
    expect(withoutSidebarHiddenProjects(groups, threads, marks, older({}, null))).toEqual({
      groups: [],
      unresolved: [],
    });
    // A project with only an unloaded hidden older thread, in a group spanning two scopes.
    const spanning = [group(["local", "c"], ["clone", "c"])];
    const cMarks = sidebarHiddenMarks({
      agreed: ["local:c-older", "clone:c-older"],
      ops: new Map(),
      attempts: [],
      unhydrated: [],
    });
    const cOlder = (rows: Array<{ id: string; projectId: string }> | null) => ({
      unloaded: () => 1,
      rows: () => rows,
    });
    expect(withoutSidebarHiddenProjects(spanning, [], cMarks, cOlder(null))).toEqual({
      groups: [],
      unresolved: ["local", "clone"],
    });
    expect(
      withoutSidebarHiddenProjects(
        spanning,
        [],
        cMarks,
        cOlder([{ id: "c-older", projectId: "c" }]),
      ),
    ).toEqual({ groups: [], unresolved: [] });
    expect(
      withoutSidebarHiddenProjects(
        spanning,
        [],
        cMarks,
        cOlder([{ id: "c-other", projectId: "c" }]),
      ),
    ).toEqual({ groups: spanning, unresolved: [] });

    // b-older is hidden but not held: it may be the one older thread the server counts.
    const held = new Set(threads.map((row) => `${row.environmentId}:${row.id}`));
    expect(unresolvedSidebarHiddenCount(marks, "local", held)).toBe(1);
    expect(unresolvedSidebarHiddenCount(marks, "clone", held)).toBe(0);
    expect(
      sidebarSettledCount({ listed: 2, scopes: [{ unloaded: 1, unresolvedHidden: 1 }] }),
    ).toEqual({ atLeast: 2, upTo: 3 });
    expect(
      sidebarSettledCount({ listed: 2, scopes: [{ unloaded: 3, unresolvedHidden: 0 }] }),
    ).toEqual({ atLeast: 5, upTo: 5 });
  });

  it("leaves an already listed or paired target where it is", () => {
    expect(planSidebarPeek({ targetListed: true, environmentSurfaced: false })).toEqual({
      hideTarget: false,
      holdEnvironment: false,
    });
    // Paired and on, but this thread is not listed (not loaded yet): only it is hidden.
    expect(planSidebarPeek({ targetListed: false, environmentSurfaced: false })).toEqual({
      hideTarget: true,
      holdEnvironment: false,
    });
  });

  it("shows an explicitly opened thread while its hidden siblings stay hidden", () => {
    const marks = sidebarHiddenMarks({
      agreed: ["clone:target", "clone:sibling"],
      ops: new Map([["clone:target", { intent: "show" as const }]]),
      attempts: [],
      unhydrated: [],
    });
    const ref = (id: string) => ({ environmentId: "clone", id });
    expect(isSidebarHiddenThread(marks, ref("target"))).toBe(false);
    expect(isSidebarHiddenThread(marks, ref("sibling"))).toBe(true);
    // Only per-thread marks hide: no local cutoff, so a thread created later shows.
    expect(isSidebarHiddenThread(marks, ref("new"))).toBe(false);
    // The Orbit panel, the palette and rail badges filter without marks: they still find all three.
    expect(visible([thread("clone", "target"), thread("clone", "sibling")])).toEqual([
      "clone:target",
      "clone:sibling",
    ]);
  });

  it("lets a show beat a provisional hide before the peek resolves", () => {
    const attempt = {
      profile: "1",
      environmentId: "clone",
      target: "clone:target",
      hold: true,
      committed: false,
      shown: [] as string[],
    };
    const marks = (shown: string[]) =>
      sidebarHiddenMarks({
        agreed: [],
        ops: new Map(),
        attempts: [{ ...attempt, shown }],
        unhydrated: [],
      });
    expect(isSidebarHiddenThread(marks([]), { environmentId: "clone", id: "target" })).toBe(true);
    expect(
      isSidebarHiddenThread(marks(["clone:target"]), { environmentId: "clone", id: "target" }),
    ).toBe(false);
    expect(
      isSidebarHiddenThread(marks(["clone:target"]), { environmentId: "clone", id: "other" }),
    ).toBe(true);
  });

  it("drops a project once Disconnect hides its last row, and keeps empty projects elsewhere", () => {
    const threads = [thread("local", "a"), thread("clone", "b", "p2")];
    const groups = [group(["local", "p1"]), group(["clone", "p2"]), group(["local", "empty"])];
    const marks = sidebarHiddenMarks({
      agreed: [],
      ops: new Map([["clone:b", { intent: "hide" as const }]]),
      attempts: [],
      unhydrated: [],
    });
    // An empty project the user already had stays, also on the environment it disconnected from.
    const withEmpty = [...groups, group(["clone", "empty"])];
    expect(withoutSidebarHiddenProjects(withEmpty, threads, marks).groups).toEqual([
      groups[0],
      groups[2],
      withEmpty[3],
    ]);
    // Archived threads do not keep a project listed, and do not count as hidden either.
    expect(
      withoutSidebarHiddenProjects(
        [group(["local", "p1"])],
        [thread("local", "a"), { ...thread("local", "old"), archivedAt: "x" as never }],
        sidebarHiddenMarks({
          agreed: ["local:a"],
          ops: new Map(),
          attempts: [],
          unhydrated: [],
        }),
      ).groups,
    ).toEqual([]);
  });
});
