import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  canContinueInNewThread: false,
  projectFilter: null,
  isPinned: false,
  highlightColor: null,
  highlightPalette: Array.from({ length: 12 }, (_, index) => ({
    label: `Color ${index + 1}`,
    color: `#${(index + 1).toString(16).padStart(2, "0")}0000`,
  })),
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  snoozeReminder: null,
  canSnoozeNow: true,
  isBlocked: false,
  canAddDependencyNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    snoozeReminder: false,
    pinning: true,
    highlight: true,
    titleRegeneration: true,
    dependencies: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("offers Default plus every palette slot under Highlight and marks the current one", () => {
    const items = buildThreadActionMenuItems({ ...baseState, highlightColor: "#020000" });
    const highlight = items.find((item) => item.id === "highlight");
    expect(highlight?.children?.map((child) => child.id)).toEqual([
      "highlight:default",
      ...Array.from({ length: 12 }, (_, index) => `highlight:${index}`),
    ]);
    expect(highlight?.children?.[0]?.label).toBe("Default");
    expect(highlight?.children?.[2]?.label).toBe("Color 2 ✓");
    expect(
      buildThreadActionMenuItems(baseState).find((item) => item.id === "highlight")?.children?.[0]
        ?.label,
    ).toBe("Default ✓");
  });

  it("hides Highlight when the environment lacks the capability", () => {
    expect(
      ids({ ...baseState, supports: { ...baseState.supports, highlight: false } }),
    ).not.toContain("highlight");
  });

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
            "highlight",
            "unsettle",
            "unsnooze",
            "depends-on",
            "new-thread-to-unblock",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "highlight",
            "settle",
            "snooze",
            "depends-on",
            "new-thread-to-unblock",
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

  it("hides Continue in new thread when thread history is off", () => {
    expect(allIds({ ...baseState, branch: "feat/menu" })).not.toContain("continue-in-new-thread");
  });

  it("offers it otherwise", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      branch: "feat/menu",
      canContinueInNewThread: true,
    });
    const index = items.findIndex((item) => item.id === "continue-in-new-thread");
    expect(items[index]?.label).toBe("Continue in new thread");
    expect(items[index - 1]?.id).toBe("new-thread-on-branch");
    // Neighbors that do different things must not look alike.
    expect(items[index]?.icon).not.toBe(items[index - 1]?.icon);
    // A thread with no branch can still be continued in the project checkout.
    expect(ids({ ...baseState, canContinueInNewThread: true })[0]).toBe("continue-in-new-thread");
  });

  it("offers Copy as thread chip in the Copy submenu", () => {
    expect(allIds(baseState)).toContain("copy-thread-chip");
    const copy = buildThreadActionMenuItems(baseState).find((item) => item.id === "copy");
    expect(copy?.children?.find((child) => child.id === "copy-thread-chip")?.label).toBe(
      "Thread chip",
    );
  });

  it("offers Snooze with reminder below Custom when the server supports reminders", () => {
    const withReminders = { ...baseState.supports, snoozeReminder: true };
    const snooze = buildThreadActionMenuItems({ ...baseState, supports: withReminders }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.children?.map((child) => [child.id, child.label])).toEqual([
      ["snooze:hour", "In 1 hour (3:00 PM)"],
      ["snooze:custom", "Custom…"],
      ["snooze:reminder", "Snooze with reminder…"],
    ]);
    expect(allIds(baseState)).not.toContain("snooze:reminder");
  });

  it("offers the way to edit or add a reminder while the thread is snoozed", () => {
    const withReminders = { ...baseState.supports, snoozeReminder: true };
    const edit = (snoozeReminder: string | null) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        isSnoozed: true,
        snoozeReminder,
        supports: withReminders,
      });
      const index = items.findIndex((item) => item.id === "snooze:reminder");
      expect(items[index - 1]?.id).toBe("unsnooze");
      return items[index]?.label;
    };
    expect(edit("Check the deploy")).toBe("Edit reminder…");
    expect(edit(null)).toBe("Add reminder…");
    expect(
      allIds({ ...baseState, isSnoozed: true, snoozeReminder: "Check the deploy" }),
    ).not.toContain("snooze:reminder");
  });

  it("offers the dependency entries directly after snooze", () => {
    const items = buildThreadActionMenuItems(baseState);
    const snoozeIndex = items.findIndex((item) => item.id === "snooze");
    expect(items[snoozeIndex + 1]).toMatchObject({ id: "depends-on", label: "Depends on…" });
    expect(items[snoozeIndex + 2]).toMatchObject({
      id: "new-thread-to-unblock",
      label: "Start a thread to unblock this",
    });
  });

  it("disables the dependency entries when the thread cannot take one", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canAddDependencyNow: false });
    expect(items.find((item) => item.id === "depends-on")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "new-thread-to-unblock")?.disabled).toBe(true);
  });

  it("hides the dependency entries when the environment lacks the capability", () => {
    const withoutDependencies = ids({
      ...baseState,
      supports: { ...baseState.supports, dependencies: false },
    });
    expect(withoutDependencies).not.toContain("depends-on");
    expect(withoutDependencies).not.toContain("new-thread-to-unblock");
    expect(withoutDependencies).toContain("snooze");
  });

  it("offers wake in place of the parking entries on a blocked thread", () => {
    const items = ids({ ...baseState, isBlocked: true });
    expect(items).toContain("release");
    expect(items).not.toContain("depends-on");
    expect(items).not.toContain("new-thread-to-unblock");
    expect(items).not.toContain("snooze");
  });

  it("labels the blocked wake entry like the snoozed one", () => {
    const release = buildThreadActionMenuItems({ ...baseState, isBlocked: true }).find(
      (item) => item.id === "release",
    );
    expect(release).toMatchObject({ label: "Wake thread", icon: "clock" });
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

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});

// Fork: roadmap.
describe("buildThreadActionMenuItems roadmap entries", () => {
  const roadmapState = (
    roadmap: Partial<NonNullable<ThreadActionMenuState["roadmap"]>> = {},
    overrides: Partial<ThreadActionMenuState> = {},
  ): ThreadActionMenuState => ({
    ...baseState,
    ...overrides,
    supports: { ...baseState.supports, roadmap: true },
    roadmap: { attachedTitle: null, createInNewThread: false, canChange: true, ...roadmap },
  });

  it("leaves the roadmap out when the home has no roadmap", () => {
    expect(allIds(baseState).filter((id) => id.startsWith("roadmap"))).toEqual([]);
    expect(
      allIds({ ...roadmapState(), supports: { ...baseState.supports, roadmap: false } }).filter(
        (id) => id.startsWith("roadmap"),
      ),
    ).toEqual([]);
  });

  it("offers create and attach for a thread on no work item", () => {
    const items = buildThreadActionMenuItems(roadmapState());
    expect(items.map((item) => item.id).filter((id) => id.startsWith("roadmap"))).toEqual([
      "roadmap-create",
      "roadmap-attach",
    ]);
    expect(items.find((item) => item.id === "roadmap-attach")?.label).toBe("Attach to work item…");
  });

  it("offers detach from the attached item in place of attach", () => {
    const items = buildThreadActionMenuItems(roadmapState({ attachedTitle: "Rebrand to Lathe" }));
    expect(items.map((item) => item.id).filter((id) => id.startsWith("roadmap"))).toEqual([
      "roadmap-create",
      "roadmap-detach",
    ]);
    expect(items.find((item) => item.id === "roadmap-detach")?.label).toBe(
      "Detach from Rebrand to Lathe",
    );
  });

  it("shortens a long attached title in the detach label", () => {
    const label = buildThreadActionMenuItems(roadmapState({ attachedTitle: "A".repeat(80) })).find(
      (item) => item.id === "roadmap-detach",
    )?.label;
    expect(label?.length).toBeLessThanOrEqual("Detach from ".length + 40);
    expect(label?.endsWith("…")).toBe(true);
  });

  it("lists the eight item types and the new-thread toggle under create", () => {
    const create = buildThreadActionMenuItems(roadmapState()).find(
      (item) => item.id === "roadmap-create",
    );
    expect(create?.label).toBe("Create work item from thread");
    expect(create?.children?.map((child) => child.id)).toEqual([
      "roadmap-create:objective",
      "roadmap-create:key-result",
      "roadmap-create:initiative",
      "roadmap-create:epic",
      "roadmap-create:feature",
      "roadmap-create:story",
      "roadmap-create:bug",
      "roadmap-create:support-ticket",
      "roadmap-create:new-thread",
    ]);
    expect(create?.children?.at(-1)).toMatchObject({
      label: "Start a new thread for it",
      checked: false,
      separatorBefore: true,
    });
    expect(
      buildThreadActionMenuItems(roadmapState({ createInNewThread: true }))
        .find((item) => item.id === "roadmap-create")
        ?.children?.at(-1)?.checked,
    ).toBe(true);
  });

  it("follows the home's permission rather than the thread's environment", () => {
    const roadmapItems = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).filter((item) => item.id.startsWith("roadmap"));
    expect(roadmapItems(roadmapState()).length).toBe(2);
    expect(
      roadmapItems(roadmapState({}, { canOperate: false })).every((item) => !item.disabled),
    ).toBe(true);
    expect(roadmapItems(roadmapState({ canChange: false })).every((item) => item.disabled)).toBe(
      true,
    );
  });
});
