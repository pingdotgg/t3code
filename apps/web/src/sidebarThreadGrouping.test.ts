import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildGroupedThreadLayout, threadKeyOf } from "./sidebarThreadGrouping";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import type { ThreadGroup } from "./uiStateStore";
import type { SidebarThreadSummary } from "./types";

const ENV = EnvironmentId.make("env-1");
const PROJ = ProjectId.make("proj-1");

function makeThread(id: string): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: ENV,
    projectId: PROJ,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function group(id: string, threads: SidebarThreadSummary[]): ThreadGroup {
  return { id, projectKey: "pk", name: id, threadKeys: threads.map(threadKeyOf) };
}

describe("buildGroupedThreadLayout", () => {
  const t1 = makeThread("t1");
  const t2 = makeThread("t2");
  const t3 = makeThread("t3");
  const t4 = makeThread("t4");

  it("splits threads into folder sections (in folder order) plus ungrouped", () => {
    const g1 = group("g1", [t2]);
    const g2 = group("g2", [t3]);
    const layout = buildGroupedThreadLayout({
      visibleProjectThreads: [t1, t2, t3, t4],
      projectKey: "pk",
      groups: { g1, g2 },
      groupOrder: ["g2", "g1"],
      groupExpandedById: {},
    });

    expect(layout.sections.map((s) => s.group.id)).toEqual(["g2", "g1"]);
    expect(layout.sections[0]!.threads).toEqual([t3]);
    expect(layout.sections[1]!.threads).toEqual([t2]);
    expect(layout.ungroupedThreads).toEqual([t1, t4]);
  });

  it("orders threads within a folder by the folder's threadKeys, not sort order", () => {
    const g1: ThreadGroup = {
      id: "g1",
      projectKey: "pk",
      name: "g1",
      threadKeys: [threadKeyOf(t3), threadKeyOf(t1)],
    };
    const layout = buildGroupedThreadLayout({
      visibleProjectThreads: [t1, t2, t3],
      projectKey: "pk",
      groups: { g1 },
      groupOrder: ["g1"],
      groupExpandedById: {},
    });
    expect(layout.sections[0]!.threads).toEqual([t3, t1]);
    expect(layout.ungroupedThreads).toEqual([t2]);
  });

  it("defaults a folder to expanded and honours an explicit collapse", () => {
    const g1 = group("g1", [t1]);
    const layout = buildGroupedThreadLayout({
      visibleProjectThreads: [t1],
      projectKey: "pk",
      groups: { g1 },
      groupOrder: ["g1"],
      groupExpandedById: { g1: false },
    });
    expect(layout.sections[0]!.expanded).toBe(false);
  });

  it("ignores folders from a different project and threads no longer visible", () => {
    const sameProject = group("g1", [t1]);
    const otherProject: ThreadGroup = {
      id: "g2",
      projectKey: "other",
      name: "g2",
      threadKeys: [threadKeyOf(t2)],
    };
    // g3 references t4, which is not in the visible set -> contributes no row.
    const staleMember: ThreadGroup = {
      id: "g3",
      projectKey: "pk",
      name: "g3",
      threadKeys: [threadKeyOf(t4)],
    };
    const layout = buildGroupedThreadLayout({
      visibleProjectThreads: [t1, t2],
      projectKey: "pk",
      groups: { g1: sameProject, g2: otherProject, g3: staleMember },
      groupOrder: ["g1", "g2", "g3"],
      groupExpandedById: {},
    });

    expect(layout.sections.map((s) => s.group.id)).toEqual(["g1", "g3"]);
    expect(layout.sections.find((s) => s.group.id === "g3")!.threads).toEqual([]);
    // t2 belongs to a folder scoped to another project, so it stays ungrouped here.
    expect(layout.ungroupedThreads).toEqual([t2]);
  });
});
