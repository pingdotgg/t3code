import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  resolveThreadGroupMenuContext,
  threadGroupArchiveConfirmDetail,
  threadGroupDeleteConfirmDetail,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isPinnedInProject: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "pin-project",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "pin-project",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers the other pin scope beside unpin", () => {
    const pinIds = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state })
        .map((item) => item.id)
        .filter((id) => id.includes("pin"));
    expect(pinIds({})).toEqual(["pin", "pin-project"]);
    expect(pinIds({ isPinned: true })).toEqual(["unpin", "pin-project"]);
    expect(pinIds({ isPinned: true, isPinnedInProject: true })).toEqual(["unpin", "pin"]);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("worker menu has detach and no pin", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      group: { role: "worker", attachCandidates: [{ key: "a", title: "Parent" }] },
    });
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain("pin");
    expect(ids).not.toContain("pin-project");
    expect(ids).not.toContain("unpin");
    expect(ids).not.toContain("attach-to-thread");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isPinned: true,
        group: { role: "worker", attachCandidates: [] },
      }).map((item) => item.id),
    ).toContain("unpin");
    expect(ids.indexOf("detach-from-group")).toBe(ids.indexOf("settle") - 1);
    expect(items.find((item) => item.id === "detach-from-group")?.label).toBe("Detach from group");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isPinned: true,
        isPinnedInProject: true,
        group: { role: "worker", attachCandidates: [] },
      })
        .map((item) => item.id)
        .filter((id) => id.includes("pin")),
    ).toEqual(["unpin"]);
  });

  it("parent menu offers settle group with only-finished", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      group: { role: "parent", attachCandidates: [] },
    });
    const settle = items.find((item) => item.id === "settle");
    expect(settle?.label).toBe("Settle group");
    expect(settle?.children?.map((child) => [child.id, child.label])).toEqual([
      ["settle", "Whole group"],
      ["settle-finished", "Only finished threads"],
    ]);
    const snooze = items.find((item) => item.id === "snooze");
    expect(snooze?.label).toBe("Snooze group");
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  it("attach submenu lists candidates", () => {
    const candidates = [
      { key: "env:one", title: "First", detail: "main" },
      { key: "env:two", title: "Second" },
    ];
    for (const role of ["none", "parent"] as const) {
      const items = buildThreadActionMenuItems({
        ...baseState,
        group: { role, attachCandidates: candidates },
      });
      const ids = items.map((item) => item.id);
      expect(ids.indexOf("attach-to-thread")).toBe(ids.indexOf("pin-project") + 1);
      const attach = items.find((item) => item.id === "attach-to-thread");
      expect(attach?.label).toBe("Attach to thread");
      expect(attach?.children).toEqual([
        { id: "attach-to-thread:env:one", label: "First", detail: "main" },
        { id: "attach-to-thread:env:two", label: "Second" },
      ]);
    }
    const ids = buildThreadActionMenuItems(baseState).map((item) => item.id);
    expect(ids).not.toContain("attach-to-thread");
  });

  it("words the group archive and delete details by count", () => {
    expect(threadGroupArchiveConfirmDetail(1)).toBe(
      "Its 1 group thread will show on its own until you unarchive it.",
    );
    expect(threadGroupArchiveConfirmDetail(3)).toBe(
      "Its 3 group threads will show on their own until you unarchive it.",
    );
    expect(threadGroupDeleteConfirmDetail(1)).toBe(
      "Its 1 group thread will stay as a regular thread.",
    );
    expect(threadGroupDeleteConfirmDetail(2)).toBe(
      "Its 2 group threads will stay as regular threads.",
    );
  });
});

describe("resolveThreadGroupMenuContext", () => {
  const environmentId = EnvironmentId.make("env");
  const shell = (
    id: string,
    overrides: Partial<{
      projectId: string;
      updatedAt: string;
      archivedAt: string | null;
      groupParentThreadId: string;
      environmentId: string;
    }> = {},
  ) =>
    ({
      id: ThreadId.make(id),
      environmentId: EnvironmentId.make(overrides.environmentId ?? "env"),
      projectId: ProjectId.make(overrides.projectId ?? "p1"),
      title: `Title ${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
      archivedAt: overrides.archivedAt ?? null,
      groupParentThreadId: overrides.groupParentThreadId
        ? ThreadId.make(overrides.groupParentThreadId)
        : null,
      groupOrderKey: null,
    }) as unknown as EnvironmentThreadShell;
  const keys = (context: ReturnType<typeof resolveThreadGroupMenuContext>) =>
    context.attachTargets.map((target) => target.key);

  it("describes a lead, its workers, and candidates without its own workers", () => {
    const lead = shell("lead");
    const worker = shell("w1", { groupParentThreadId: "lead" });
    const other = shell("other");
    const context = resolveThreadGroupMenuContext([lead, worker, other], lead);
    expect(context.group.role).toBe("parent");
    expect(context.workers).toEqual([worker]);
    expect(context.group.attachCandidates).toEqual([{ key: "env:other", title: "Title other" }]);
    expect(context.attachTargets).toEqual([
      { key: "env:other", title: "Title other", ref: { environmentId, threadId: "other" } },
    ]);
  });

  it("marks a worker without workers of its own", () => {
    const lead = shell("lead");
    const worker = shell("w1", { groupParentThreadId: "lead" });
    const context = resolveThreadGroupMenuContext([lead, worker], worker);
    expect(context.group.role).toBe("worker");
    expect(context.workers).toEqual([]);
  });

  it("treats an ungrouped thread as standalone and skips archived or foreign-environment threads", () => {
    const thread = shell("solo");
    const context = resolveThreadGroupMenuContext(
      [
        thread,
        shell("archived", { archivedAt: "2026-02-01T00:00:00.000Z" }),
        shell("foreign", { environmentId: "other-env" }),
        shell("ok"),
      ],
      thread,
    );
    expect(context.group.role).toBe("none");
    expect(context.workers).toEqual([]);
    expect(keys(context)).toEqual(["env:ok"]);
  });

  it("lists the same project first, newest activity first within each tier", () => {
    const thread = shell("me");
    const context = resolveThreadGroupMenuContext(
      [
        thread,
        shell("foreign-new", { projectId: "p2", updatedAt: "2026-03-03T00:00:00.000Z" }),
        shell("same-old", { updatedAt: "2026-01-02T00:00:00.000Z" }),
        shell("foreign-old", { projectId: "p2", updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("same-new", { updatedAt: "2026-02-02T00:00:00.000Z" }),
      ],
      thread,
    );
    expect(keys(context)).toEqual([
      "env:same-new",
      "env:same-old",
      "env:foreign-new",
      "env:foreign-old",
    ]);
  });

  it("caps candidates at 30 after ordering", () => {
    const thread = shell("me");
    const many = Array.from({ length: 40 }, (_, index) =>
      shell(`t${index}`, {
        updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const context = resolveThreadGroupMenuContext([thread, ...many], thread);
    expect(context.attachTargets).toHaveLength(30);
    expect(keys(context)[0]).toBe("env:t39");
    expect(keys(context).at(-1)).toBe("env:t10");
  });
});
