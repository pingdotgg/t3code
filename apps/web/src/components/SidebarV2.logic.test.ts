import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  generateSpreadPinOrderKeys,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  indexWorktreeThreads,
  resolveWorktreeLifecycle,
  worktreeLifecycleTargets,
  resolveWorktreeMetadata,
  planWorktreeGroupReorder,
  worktreeReorderSection,
} from "@t3tools/client-runtime/state/worktree-grouping";
import { worktreeScopeKey } from "@t3tools/shared/worktreeResource";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import {
  buildSidebarWorktreeGroups,
  pickWorktreeGroupRepresentative,
  pickWorktreeGroupTimeLabelThread,
  resolveWorktreeGroupLiveStatus,
  type SidebarThreadClassification,
  sidebarThreadKey,
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
    latestRun: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    runtime: null,
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
    const first = makeShell({
      id: ThreadId.make("thread-a"),
      worktreePath: "/wt/one",
    });
    const second = makeShell({
      id: ThreadId.make("thread-b"),
      worktreePath: "/wt/two",
    });
    const { activeGroups } = buildSidebarWorktreeGroups(classifyAll([first, second]));
    expect(activeGroups).toHaveLength(2);
  });

  it("classifies the group by its most-alive member: any active member keeps the card active", () => {
    const settled = makeShell({
      id: ThreadId.make("thread-settled"),
      worktreePath: "/wt/x",
    });
    const active = makeShell({
      id: ThreadId.make("thread-active"),
      worktreePath: "/wt/x",
    });
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
    const settled = makeShell({
      id: ThreadId.make("thread-settled"),
      worktreePath: "/wt/x",
    });
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

  it("keeps pinned worktrees above unpinned worktrees in persisted pin order", () => {
    const unpinned = makeShell({
      id: ThreadId.make("thread-unpinned"),
      worktreePath: "/wt/new",
      createdAt: "2026-03-09T15:00:00.000Z",
    });
    const pinnedLater = makeShell({
      id: ThreadId.make("thread-pinned-later"),
      worktreePath: "/wt/pinned-later",
      pinnedAt: "2026-03-09T11:00:00.000Z",
      pinOrderKey: "m",
    });
    const pinnedFirst = makeShell({
      id: ThreadId.make("thread-pinned-first"),
      worktreePath: "/wt/pinned-first",
      pinnedAt: "2026-03-09T12:00:00.000Z",
      pinOrderKey: "a",
    });
    const { activeGroups } = buildSidebarWorktreeGroups(
      classifyAll([unpinned, pinnedLater, pinnedFirst]),
    );
    expect(activeGroups.map((group) => group.key)).toEqual([
      worktreeScopeKey(environmentId, ProjectId.make("project-1"), "/wt/pinned-first"),
      worktreeScopeKey(environmentId, ProjectId.make("project-1"), "/wt/pinned-later"),
      worktreeScopeKey(environmentId, ProjectId.make("project-1"), "/wt/new"),
    ]);
  });
});

describe("pickWorktreeGroupRepresentative", () => {
  it("prefers the route thread when it is a member", () => {
    const first = makeShell({
      id: ThreadId.make("thread-a"),
      worktreePath: "/wt/x",
    });
    const second = makeShell({
      id: ThreadId.make("thread-b"),
      worktreePath: "/wt/x",
    });
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
      runtime: {
        status: "running",
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        updatedAt: startedAt,
      } as EnvironmentThreadShell["runtime"],
      latestRun: {
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
      } as EnvironmentThreadShell["latestRun"],
    });

  it("returns null when every member is at rest", () => {
    expect(resolveWorktreeGroupLiveStatus([makeShell(), makeShell()])).toBeNull();
  });

  it("ranks approval above working", () => {
    const status = resolveWorktreeGroupLiveStatus([
      running("2026-03-09T10:00:00.000Z"),
      makeShell({
        id: ThreadId.make("thread-approval"),
        hasPendingApprovals: true,
      }),
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

describe("worktree metadata", () => {
  const link: EnvironmentThreadShell["pullRequests"][number] = {
    host: "github.com",
    repository: "team/repo",
    number: 12,
    url: "https://github.com/team/repo/pull/12",
    source: "manual",
    linkedAt: "2026-09-17T10:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("collects unique PRs from every sibling, preserving distinct repositories and newest snapshots", () => {
    const olderThread = makeShell({
      updatedAt: "2026-09-17T09:00:00Z",
      pullRequests: [
        {
          ...link,
          snapshot: {
            state: "merged",
            title: "Change",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-09-17T12:00:00Z",
            syncedAt: "2026-09-17T12:01:00Z",
          },
        },
        { ...link, repository: "team/other", url: "https://github.com/team/other/pull/12" },
      ],
    });
    const newerThread = makeShell({ updatedAt: "2026-09-17T11:00:00Z", pullRequests: [link] });
    const result = resolveWorktreeMetadata([olderThread, newerThread]);
    expect(result.thread).toBe(newerThread);
    expect(result.pullRequests).toHaveLength(2);
    expect(result.pullRequests[0]?.snapshot?.state).toBe("merged");
    expect(result.pullRequests[1]?.repository).toBe("team/other");
  });
  it("does not let a dismissed stack link hide a sibling's explicit PR or fallback", () => {
    const fallback = {
      projectId: ProjectId.make("project-1"),
      repository: "team/repo",
      number: 12,
      url: link.url,
    };
    const newerThread = makeShell({
      updatedAt: "2026-09-17T11:00:00Z",
      pullRequests: [{ ...link, source: "stack-dismissed" }],
    });
    const olderThread = makeShell({
      updatedAt: "2026-09-17T09:00:00Z",
      pullRequests: [link],
      linkedPullRequest: fallback,
      branchPullRequest: fallback,
    });
    const result = resolveWorktreeMetadata([newerThread, olderThread]);
    expect(result.pullRequests).toEqual([link]);
    expect(result.linkedPullRequest).toBe(fallback);
    expect(result.branchPullRequest).toBe(fallback);
  });
});

describe("worktree group reordering", () => {
  function fixtures() {
    return [
      makeShell({
        id: ThreadId.make("a1"),
        worktreePath: "/wt/a",
        createdAt: "2026-09-17T12:00:00Z",
        activeOrderKey: "b",
      }),
      makeShell({
        id: ThreadId.make("a2"),
        worktreePath: "/wt/a",
        createdAt: "2026-09-17T12:01:00Z",
        activeOrderKey: "c",
      }),
      makeShell({ id: ThreadId.make("b1"), worktreePath: "/wt/b", activeOrderKey: "m" }),
      makeShell({ id: ThreadId.make("b2"), worktreePath: "/wt/b", activeOrderKey: "n" }),
      makeShell({ id: ThreadId.make("c1"), worktreePath: "/wt/c", activeOrderKey: "x" }),
    ];
  }
  function groups(threads: EnvironmentThreadShell[]) {
    const sorted = sortActiveThreadsByOrderKey(threads);
    return buildSidebarWorktreeGroups(classifyAll(threads), {
      activeThreadOrder: sorted.map(sidebarThreadKey),
    }).activeGroups;
  }
  function plan(threads: EnvironmentThreadShell[], from: number, to: number) {
    const list = groups(threads);
    return planWorktreeGroupReorder({
      groups: list,
      activeKey: list[from]!.key,
      overKey: list[to]!.key,
      keysById: new Map(threads.map((thread) => [sidebarThreadKey(thread), thread.activeOrderKey])),
      reorderableKeys: new Set(threads.map(sidebarThreadKey)),
    });
  }
  it.each([
    [0, 2],
    [2, 0],
    [0, 1],
    [1, 0],
  ])(
    "moves the whole group from %s to %s and restores that order from persisted member keys",
    (from, to) => {
      const threads = fixtures();
      const before = groups(threads);
      const result = plan(threads, from, to)!;
      const changes = new Map(result.assignments.map(({ id, orderKey }) => [id, orderKey]));
      const restored = groups(
        threads.map((thread) => ({
          ...thread,
          activeOrderKey: changes.get(sidebarThreadKey(thread)) ?? thread.activeOrderKey,
        })),
      );
      expect(restored.map((group) => group.key)).toEqual(result.order);
      expect(result.assignments.map(({ id }) => id)).toEqual(before[from]!.memberKeys);
      expect(restored.find((group) => group.key === before[from]!.key)?.memberKeys).toEqual(
        before[from]!.memberKeys,
      );
    },
  );
  it("materializes keyless groups without overwriting filtered threads or colliding with their keys", () => {
    const threads = fixtures().map((thread) => ({ ...thread, activeOrderKey: null }));
    const list = groups(threads);
    const hiddenKey = generateSpreadPinOrderKeys(threads.length + 1)[0]!;
    const result = planWorktreeGroupReorder({
      groups: list,
      activeKey: list[0]!.key,
      overKey: list[2]!.key,
      keysById: new Map([
        ...threads.map((thread) => [sidebarThreadKey(thread), null] as const),
        ["hidden", hiddenKey],
      ]),
      reorderableKeys: new Set(threads.map(sidebarThreadKey)),
    })!;
    expect(result.assignments).toHaveLength(threads.length);
    expect(
      result.assignments.some(({ id, orderKey }) => id === "hidden" || orderKey === hiddenKey),
    ).toBe(false);
    const changes = new Map(result.assignments.map(({ id, orderKey }) => [id, orderKey]));
    expect(
      groups(
        threads.map((thread) => ({
          ...thread,
          activeOrderKey: changes.get(sidebarThreadKey(thread))!,
        })),
      ).map((group) => group.key),
    ).toEqual(result.order);
  });
  it("moves active siblings together without writing parked siblings' keys or changing lifecycle fields", () => {
    const threads = fixtures();
    const parked = makeShell({
      id: ThreadId.make("parked"),
      worktreePath: "/wt/a",
      settledOverride: "settled",
      activeOrderKey: "d",
    });
    const sleeping = makeShell({
      id: ThreadId.make("sleeping"),
      worktreePath: "/wt/a",
      snoozedUntil: "2027-01-01T00:00:00Z",
      activeOrderKey: "e",
    });
    const list = buildSidebarWorktreeGroups(
      [
        ...classifyAll(threads),
        { thread: parked, classification: "settled" },
        { thread: sleeping, classification: "snoozed" },
      ],
      { activeThreadOrder: threads.map(sidebarThreadKey) },
    ).activeGroups;
    const input = [...threads, parked, sleeping];
    const original = structuredClone(input);
    const result = planWorktreeGroupReorder({
      groups: list,
      activeKey: list[0]!.key,
      overKey: list[2]!.key,
      keysById: new Map(input.map((thread) => [sidebarThreadKey(thread), thread.activeOrderKey])),
      reorderableKeys: new Set(threads.map(sidebarThreadKey)),
    })!;
    expect(result.assignments.map(({ id }) => id)).toEqual(
      threads.slice(0, 2).map(sidebarThreadKey),
    );
    expect(list[0]?.threads).toContain(parked);
    expect(list[0]?.threads).toContain(sleeping);
    expect(input).toEqual(original);
  });
  it("writes only pinned members when reordering pinned worktrees and rejects crossing their boundary", () => {
    const threads = fixtures().map((thread, index) =>
      index === 0 || index === 2
        ? { ...thread, pinnedAt: "2026-09-17T12:00:00Z", pinOrderKey: index === 0 ? "b" : "m" }
        : thread,
    );
    const pinned = sortPinnedThreadsByOrderKey(threads.filter((thread) => thread.pinnedAt != null));
    const list = buildSidebarWorktreeGroups(classifyAll(threads), {
      activeThreadOrder: [...pinned, ...threads.filter((thread) => thread.pinnedAt == null)].map(
        sidebarThreadKey,
      ),
    }).activeGroups;
    const input = {
      groups: list,
      activeKey: list[0]!.key,
      overKey: list[1]!.key,
      keysById: new Map(threads.map((thread) => [sidebarThreadKey(thread), thread.pinOrderKey])),
      reorderableKeys: new Set(pinned.map(sidebarThreadKey)),
    };
    const result = planWorktreeGroupReorder(input)!;
    expect(result.section).toBe("pinned");
    expect(result.assignments.map(({ id }) => id)).toEqual([sidebarThreadKey(threads[0]!)]);
    expect(planWorktreeGroupReorder({ ...input, overKey: list[2]!.key })).toBeNull();
    expect(worktreeReorderSection({ ...list[0]!, section: "settled" })).toBeNull();
  });
  it("rejects a no-op or a materialization requiring an unsupported server", () => {
    const threads = fixtures().map((thread) => ({ ...thread, activeOrderKey: null }));
    const list = groups(threads);
    const input = {
      groups: list,
      activeKey: list[0]!.key,
      overKey: list[0]!.key,
      keysById: new Map<string, string | null>(),
      reorderableKeys: new Set(list[0]!.memberKeys),
    };
    expect(planWorktreeGroupReorder(input)).toBeNull();
    expect(planWorktreeGroupReorder({ ...input, overKey: list[2]!.key })).toBeNull();
  });
});

describe("worktree lifecycle actions", () => {
  const now = "2026-09-17T12:00:00Z";
  const member = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
    makeShell({ id: ThreadId.make(id), worktreePath: "/wt/shared", pinnedAt: null, ...overrides });
  it("includes hidden siblings but isolates environments, projects and archived threads", () => {
    const a = member("a");
    const b = member("b");
    const map = indexWorktreeThreads([
      a,
      b,
      member("archived", { archivedAt: now }),
      member("other-env", { environmentId: EnvironmentId.make("remote") }),
      member("other-project", { projectId: ProjectId.make("other") }),
    ]);
    expect(map.get(sidebarThreadKey(a))).toEqual([a, b]);
    expect(map.get(sidebarThreadKey(b))).toBe(map.get(sidebarThreadKey(a)));
  });
  it("pins unpinned members and unpins every pin in a mixed worktree", () => {
    const a = member("a", { pinnedAt: now });
    const b = member("b");
    expect(resolveWorktreeLifecycle([a, b], now).isPinned).toBe(true);
    expect(worktreeLifecycleTargets([a, b], "pin", now)).toEqual([b]);
    expect(worktreeLifecycleTargets([a, b], "unpin", now)).toEqual([a]);
  });
  it("settles every active sibling and exposes the reverse after the whole worktree settles", () => {
    const a = member("a", { settledOverride: "settled" });
    const b = member("b");
    expect(resolveWorktreeLifecycle([a, b], now).isSettled).toBe(false);
    expect(worktreeLifecycleTargets([a, b], "settle", now)).toEqual([b]);
    const settled = { ...b, settledOverride: "settled" as const };
    expect(resolveWorktreeLifecycle([a, settled], now).isSettled).toBe(true);
    expect(worktreeLifecycleTargets([a, settled], "unsettle", now)).toEqual([a, settled]);
  });
  it("wakes all snoozed members and ignores expired snoozes", () => {
    const a = member("a", { snoozedUntil: "2026-09-18T12:00:00Z" });
    const b = member("b", { snoozedUntil: "2026-09-16T12:00:00Z" });
    const c = member("c", { snoozedUntil: "2026-09-19T12:00:00Z" });
    expect(resolveWorktreeLifecycle([a, b, c], now).isSnoozed).toBe(true);
    expect(worktreeLifecycleTargets([a, b, c], "unsnooze", now)).toEqual([a, c]);
  });
  it("blocks group snooze when any member is waiting on the user", () => {
    expect(
      resolveWorktreeLifecycle([member("a"), member("b", { hasPendingApprovals: true })], now)
        .canSnoozeNow,
    ).toBe(false);
    expect(resolveWorktreeLifecycle([member("a"), member("b")], now).canSnoozeNow).toBe(true);
  });
});
