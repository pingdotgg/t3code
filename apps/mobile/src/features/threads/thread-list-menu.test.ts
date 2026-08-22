import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadListMenuActions } from "./thread-list-menu";

describe("buildThreadListMenuActions", () => {
  it("mirrors web's grouping: lifecycle, title actions with mark-unread, Copy submenu, archive/delete tail", () => {
    const actions = buildThreadListMenuActions({
      thread: {
        branch: "feature/mobile-menu",
        id: ThreadId.make("thread-1"),
        titleRegeneration: null,
      },
      lifecycleActions: [{ id: "settle", title: "Settle thread" }],
      titleRegenerationSupported: true,
      isRunning: false,
    });

    expect(actions.map((action) => action.id)).toEqual([
      "new-thread-on-branch",
      "settle",
      "thread-title-actions",
      "copy",
      "thread-delete-actions",
    ]);
    expect(actions[0]?.title).toBe("New thread on feature/mobile-menu");
    expect(actions[2]?.subactions?.map((action) => action.id)).toEqual([
      "rename",
      "regenerate-title",
      "mark-unread",
    ]);
    expect(actions[3]?.subactions?.map((action) => action.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
    expect(actions[4]?.subactions?.map((action) => action.id)).toEqual(["archive", "delete"]);
  });

  it("disables Archive while a turn runs and hides it when it is the lifecycle action", () => {
    const running = buildThreadListMenuActions({
      thread: { branch: null, id: ThreadId.make("thread-1"), titleRegeneration: null },
      lifecycleActions: [],
      titleRegenerationSupported: true,
      isRunning: true,
    });
    const deleteGroup = running.find((action) => action.id === "thread-delete-actions");
    expect(
      deleteGroup?.subactions?.find((action) => action.id === "archive")?.attributes?.disabled,
    ).toBe(true);

    // Compact rows carry Archive as their whole lifecycle slot.
    const compact = buildThreadListMenuActions({
      thread: { branch: null, id: ThreadId.make("thread-1"), titleRegeneration: null },
      lifecycleActions: [{ id: "archive", title: "Archive thread", image: "archivebox" }],
      titleRegenerationSupported: true,
      isRunning: true,
      showArchiveAction: false,
    });
    expect(compact.find((action) => action.id === "archive")?.attributes?.disabled).toBe(true);

    expect(compact.filter((action) => action.id === "archive")).toHaveLength(1);
  });

  it("gates title regeneration, the branch action, and disables regeneration while in flight", () => {
    const actions = buildThreadListMenuActions({
      thread: {
        branch: "main",
        id: ThreadId.make("thread-1"),
        titleRegeneration: {
          requestId: CommandId.make("request-1"),
          startedAt: "2026-08-08T00:00:00.000Z",
        },
      },
      lifecycleActions: [],
      titleRegenerationSupported: true,
    });
    const regenerate = actions
      .flatMap((candidate) => candidate.subactions ?? [candidate])
      .find((candidate) => candidate.id === "regenerate-title");

    expect(regenerate?.title).toBe("Regenerating…");
    expect(regenerate?.attributes?.disabled).toBe(true);

    const copySubactions = actions.find((action) => action.id === "copy")?.subactions ?? [];
    expect(copySubactions.map((action) => action.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
  });
});
