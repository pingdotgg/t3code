import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  buildSidebarWorktreeGroups,
  pickWorktreeGroupRepresentative,
  pickWorktreeGroupTimeLabelThread,
  resolveWorktreeGroupLiveStatus,
  sidebarThreadKey,
  type SidebarThreadClassification,
} from "./SidebarV2.logic";

const environmentId = EnvironmentId.make("environment-local");

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

function classifyAll(
  threads: EnvironmentThreadShell[],
  classification: SidebarThreadClassification = "active",
) {
  return threads.map((thread) => ({ thread, classification }));
}

describe("buildSidebarWorktreeGroups", () => {
  it("groups threads sharing a worktree path into one card, oldest member first", () => {
    const older = makeShell({
      id: ThreadId.make("thread-older"),
      worktreePath: "/wt/feature",
      createdAt: "2026-03-09T10:00:00.000Z",
    });
    const newer = makeShell({
      id: ThreadId.make("thread-newer"),
      worktreePath: "/wt/feature",
      createdAt: "2026-03-09T11:00:00.000Z",
    });
    const { activeGroups } = buildSidebarWorktreeGroups(classifyAll([newer, older]));
    expect(activeGroups).toHaveLength(1);
    expect(activeGroups[0]!.threads.map((thread) => thread.id)).toEqual([older.id, newer.id]);
    expect(activeGroups[0]!.memberKeys).toEqual([sidebarThreadKey(older), sidebarThreadKey(newer)]);
  });

  it("groups local-checkout threads (null worktreePath) per project, not per thread", () => {
    const localA = makeShell({ id: ThreadId.make("thread-a") });
    const localB = makeShell({ id: ThreadId.make("thread-b") });
    const otherProject = makeShell({
      id: ThreadId.make("thread-c"),
      projectId: ProjectId.make("project-2"),
    });
    const { activeGroups } = buildSidebarWorktreeGroups(
      classifyAll([localA, localB, otherProject]),
    );
    expect(activeGroups).toHaveLength(2);
    const sizes = activeGroups.map((group) => group.threads.length).toSorted();
    expect(sizes).toEqual([1, 2]);
  });

  it("keeps distinct worktrees as distinct cards", () => {
    const first = makeShell({ id: ThreadId.make("thread-a"), worktreePath: "/wt/one" });
    const second = makeShell({ id: ThreadId.make("thread-b"), worktreePath: "/wt/two" });
    const { activeGroups } = buildSidebarWorktreeGroups(classifyAll([first, second]));
    expect(activeGroups).toHaveLength(2);
  });

  it("classifies the group by its most-alive member: any active member keeps the card active", () => {
    const settled = makeShell({ id: ThreadId.make("thread-settled"), worktreePath: "/wt/x" });
    const active = makeShell({ id: ThreadId.make("thread-active"), worktreePath: "/wt/x" });
    const { activeGroups, settledGroups } = buildSidebarWorktreeGroups([
      { thread: settled, classification: "settled" },
      { thread: active, classification: "active" },
    ]);
    expect(activeGroups).toHaveLength(1);
    expect(settledGroups).toHaveLength(0);
    expect(activeGroups[0]!.threads).toHaveLength(2);
  });

  it("shelves a group as snoozed when members are snoozed and none active", () => {
    const snoozed = makeShell({
      id: ThreadId.make("thread-snoozed"),
      worktreePath: "/wt/x",
      snoozedUntil: "2026-03-10T10:00:00.000Z",
    });
    const settled = makeShell({ id: ThreadId.make("thread-settled"), worktreePath: "/wt/x" });
    const { activeGroups, snoozedGroups, settledGroups } = buildSidebarWorktreeGroups([
      { thread: snoozed, classification: "snoozed" },
      { thread: settled, classification: "settled" },
    ]);
    expect(activeGroups).toHaveLength(0);
    expect(snoozedGroups).toHaveLength(1);
    expect(settledGroups).toHaveLength(0);
  });

  it("shelves a group as settled only when every member settled", () => {
    const first = makeShell({
      id: ThreadId.make("thread-a"),
      worktreePath: "/wt/x",
      settledAt: "2026-03-09T12:00:00.000Z",
    });
    const second = makeShell({
      id: ThreadId.make("thread-b"),
      worktreePath: "/wt/x",
      settledAt: "2026-03-09T13:00:00.000Z",
    });
    const { settledGroups } = buildSidebarWorktreeGroups(classifyAll([first, second], "settled"));
    expect(settledGroups).toHaveLength(1);
    expect(settledGroups[0]!.threads).toHaveLength(2);
  });

  it("orders cards statically by their newest member, newest worktree on top", () => {
    const oldWorktree = makeShell({
      id: ThreadId.make("thread-old"),
      worktreePath: "/wt/old",
      createdAt: "2026-03-09T09:00:00.000Z",
    });
    const busyWorktreeOldMember = makeShell({
      id: ThreadId.make("thread-busy-old"),
      worktreePath: "/wt/busy",
      createdAt: "2026-03-09T08:00:00.000Z",
    });
    const busyWorktreeNewMember = makeShell({
      id: ThreadId.make("thread-busy-new"),
      worktreePath: "/wt/busy",
      createdAt: "2026-03-09T12:00:00.000Z",
    });
    const { activeGroups } = buildSidebarWorktreeGroups(
      classifyAll([oldWorktree, busyWorktreeOldMember, busyWorktreeNewMember]),
    );
    expect(activeGroups.map((group) => group.threads[0]!.worktreePath)).toEqual([
      "/wt/busy",
      "/wt/old",
    ]);
  });
});

describe("pickWorktreeGroupRepresentative", () => {
  it("prefers the route thread when it is a member", () => {
    const first = makeShell({ id: ThreadId.make("thread-a"), worktreePath: "/wt/x" });
    const second = makeShell({ id: ThreadId.make("thread-b"), worktreePath: "/wt/x" });
    const { activeGroups } = buildSidebarWorktreeGroups(classifyAll([first, second]));
    const representative = pickWorktreeGroupRepresentative(
      activeGroups[0]!,
      sidebarThreadKey(first),
    );
    expect(representative.id).toBe(first.id);
  });

  it("uses the most recently settled member for settled groups", () => {
    const earlier = makeShell({
      id: ThreadId.make("thread-a"),
      worktreePath: "/wt/x",
      settledAt: "2026-03-09T12:00:00.000Z",
    });
    const later = makeShell({
      id: ThreadId.make("thread-b"),
      worktreePath: "/wt/x",
      settledAt: "2026-03-09T15:00:00.000Z",
    });
    const { settledGroups } = buildSidebarWorktreeGroups(classifyAll([earlier, later], "settled"));
    expect(pickWorktreeGroupRepresentative(settledGroups[0]!, null).id).toBe(later.id);
  });

  it("uses the soonest-waking snoozed member for snoozed groups", () => {
    const wakesLater = makeShell({
      id: ThreadId.make("thread-a"),
      worktreePath: "/wt/x",
      snoozedUntil: "2026-03-11T10:00:00.000Z",
    });
    const wakesSooner = makeShell({
      id: ThreadId.make("thread-b"),
      worktreePath: "/wt/x",
      snoozedUntil: "2026-03-10T10:00:00.000Z",
    });
    const { snoozedGroups } = buildSidebarWorktreeGroups(
      classifyAll([wakesLater, wakesSooner], "snoozed"),
    );
    expect(pickWorktreeGroupRepresentative(snoozedGroups[0]!, null).id).toBe(wakesSooner.id);
  });
});

describe("resolveWorktreeGroupLiveStatus", () => {
  const running = (startedAt: string) =>
    makeShell({
      id: ThreadId.make(`thread-run-${startedAt}`),
      session: {
        status: "running",
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        updatedAt: startedAt,
      } as EnvironmentThreadShell["session"],
      latestTurn: {
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
      } as EnvironmentThreadShell["latestTurn"],
    });

  it("returns null when every member is at rest", () => {
    expect(resolveWorktreeGroupLiveStatus([makeShell(), makeShell()])).toBeNull();
  });

  it("ranks approval above working", () => {
    const status = resolveWorktreeGroupLiveStatus([
      running("2026-03-09T10:00:00.000Z"),
      makeShell({ id: ThreadId.make("thread-approval"), hasPendingApprovals: true }),
    ]);
    expect(status?.kind).toBe("approval");
  });

  it("counts working from the earliest in-flight member", () => {
    const status = resolveWorktreeGroupLiveStatus([
      running("2026-03-09T11:00:00.000Z"),
      running("2026-03-09T10:00:00.000Z"),
    ]);
    expect(status?.kind).toBe("working");
    expect(status?.workingStartedAt).toBe("2026-03-09T10:00:00.000Z");
  });
});

describe("pickWorktreeGroupTimeLabelThread", () => {
  it("returns the member with the latest activity", () => {
    const stale = makeShell({
      id: ThreadId.make("thread-stale"),
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const fresh = makeShell({
      id: ThreadId.make("thread-fresh"),
      latestUserMessageAt: "2026-03-09T12:00:00.000Z",
    });
    expect(pickWorktreeGroupTimeLabelThread([stale, fresh]).id).toBe(fresh.id);
  });
});
