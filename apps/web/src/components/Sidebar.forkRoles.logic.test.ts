import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type RoleThread,
  resolveRolesSection,
  roleRowState,
  splitRoleThreads,
} from "./Sidebar.forkRoles.logic";
import { createSidebarSortingStrategy } from "./Sidebar.drag";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const environmentId = EnvironmentId.make("env");
const completedAt = "2026-11-23T10:05:00.000Z";

function role(title: string, overrides: Partial<RoleThread> = {}): RoleThread {
  return {
    environmentId,
    id: ThreadId.make(title),
    title,
    roleId: title.toLowerCase(),
    settledOverride: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    runtime: null,
    lastVisitedAt: completedAt,
    latestRun: {
      runId: "run" as never,
      status: "completed",
      assistantMessageId: null,
      requestedAt: "2026-11-23T10:00:00.000Z",
      startedAt: "2026-11-23T10:00:00.000Z",
      completedAt,
    },
    ...overrides,
  } as RoleThread;
}

const unread = role("Unread", {
  lastVisitedAt: "2026-11-23T09:00:00.000Z",
  latestRun: { ...role("x").latestRun!, status: "failed" },
});
const completed = role("Completed");
const settled = role("Settled", { settledOverride: "settled" });
const working = role("Working", {
  runtime: {
    status: "running",
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: completedAt,
  },
});
const keyOf = (thread: RoleThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const titles = (section: ReturnType<typeof resolveRolesSection<RoleThread>>) =>
  section.rows.map(({ thread, dimmed }) => `${thread.title}${dimmed ? " (dim)" : ""}`);
const all = [working, settled, unread, completed];
const closed = { expanded: true, showAll: false, routeThreadKey: null };

describe("roleRowState", () => {
  it("needs the user when unread, even if the run failed", () => {
    expect(roleRowState(unread)).toBe("needs-you");
  });

  it("needs the user when its latest run completed, read or not", () => {
    expect(roleRowState(completed)).toBe("needs-you");
  });

  it("is quiet once settled, and working while it runs", () => {
    expect(roleRowState(settled)).toBe("quiet");
    expect(roleRowState(working)).toBe("working");
  });
});

describe("resolveRolesSection", () => {
  it("lists only roles that need the user, counts them, and flags a working role", () => {
    const section = resolveRolesSection(all, closed);
    expect(titles(section)).toEqual(["Completed", "Unread"]);
    expect(section.needsYouCount).toBe(2);
    expect(section.working).toBe(true);
  });

  it("reveals quiet and working roles dimmed under show all", () => {
    expect(titles(resolveRolesSection(all, { ...closed, showAll: true }))).toEqual([
      "Completed",
      "Settled (dim)",
      "Unread",
      "Working (dim)",
    ]);
  });

  it("keeps the routed role visible while hidden or collapsed", () => {
    expect(titles(resolveRolesSection(all, { ...closed, routeThreadKey: keyOf(settled) }))).toEqual(
      ["Completed", "Settled (dim)", "Unread"],
    );
    expect(
      titles(
        resolveRolesSection(all, { ...closed, expanded: false, routeThreadKey: keyOf(working) }),
      ),
    ).toEqual(["Working (dim)"]);
  });

  it("collapses to its header when no role needs the user", () => {
    const section = resolveRolesSection([settled, working], closed);
    expect(section.rows).toEqual([]);
    expect(section.needsYouCount).toBe(0);
  });
});

describe("splitRoleThreads", () => {
  it("takes settled and pinned roles out of every other section", () => {
    const pinned = { ...role("Pinned"), pinnedAt: completedAt };
    const plainSettled = { ...role("Plain", { settledOverride: "settled" }), roleId: null };
    const { roles, others } = splitRoleThreads([settled, pinned, plainSettled]);
    expect(roles).toEqual([settled, pinned]);
    expect(others).toEqual([plainSettled]);
  });
});

describe("roles block while dragging", () => {
  const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
  const row = (key: string, section: SidebarSection): SidebarListItem => ({
    kind: "thread",
    key,
    section,
  });
  const items = [
    marker("roles-header"),
    row("role", "roles"),
    marker("pinned-header"),
    row("pinned", "pinned"),
    marker("pinned-divider"),
    marker("active-placeholder"),
    row("active", "active"),
    row("other", "active"),
    marker("settled-header"),
    marker("settled-placeholder"),
  ];

  it("takes no drops and keeps role rows out of the pinned order", () => {
    expect(resolveSidebarDropTarget(items, "active", "role")).toBeNull();
    expect(resolveSidebarDropTarget(items, "active", "roles-header")).toBeNull();
    expect(resolveSidebarDropTarget(items, "active", "pinned")).toMatchObject({
      section: "pinned",
      pinnedOrder: ["active", "pinned"],
    });
  });

  it("holds the roles block in place while a row moves to Pinned", () => {
    let top = 0;
    const rects = items.map((item) => {
      const height = item.kind === "thread" ? (item.section === "roles" ? 54 : 82) : 32;
      const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
      top += height + 1;
      return rect;
    });
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const activeIndex = items.findIndex((item) => sidebarListItemId(item) === "active");
    const args = {
      activeIndex,
      overIndex: items.findIndex((item) => sidebarListItemId(item) === "pinned"),
      activeNodeRect: rects[activeIndex]!,
      rects,
    };
    const transform = (id: string) =>
      strategy({ ...args, index: items.findIndex((item) => sidebarListItemId(item) === id) });
    expect(transform(sidebarMarkerId("roles-header"))).toMatchObject({ y: 0, scaleY: 1 });
    expect(transform("role")).toMatchObject({ y: 0, scaleY: 1 });
    expect(transform("pinned")?.y).toBeGreaterThan(0);
  });
});
