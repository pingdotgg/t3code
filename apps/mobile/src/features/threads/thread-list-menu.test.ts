import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadListMenuActions } from "./thread-list-menu";

describe("buildThreadListMenuActions", () => {
  it("adds the desktop thread actions around the existing lifecycle actions", () => {
    const actions = buildThreadListMenuActions({
      thread: { branch: "feature/mobile-menu", titleRegeneration: null },
      lifecycleActions: [{ id: "settle", title: "Settle" }],
      titleRegenerationSupported: true,
    });

    expect(actions.map((action) => action.id)).toEqual([
      "new-thread-on-branch",
      "settle",
      "thread-title-actions",
      "thread-utility-actions",
      "thread-delete-actions",
    ]);
    expect(actions[0]?.title).toBe("New thread on feature/mobile-menu");
    expect(actions[2]?.subactions?.map((action) => action.id)).toEqual([
      "rename",
      "regenerate-title",
    ]);
    expect(actions[3]?.subactions?.map((action) => action.id)).toEqual([
      "mark-unread",
      "copy-path",
      "copy-branch",
    ]);
    expect(actions[3]?.subactions?.map((action) => action.image)).toEqual([
      "envelope.badge",
      "doc.on.doc",
      "arrow.triangle.branch",
    ]);
  });

  it("gates title regeneration and the branch action", () => {
    const actions = buildThreadListMenuActions({
      thread: { branch: null, titleRegeneration: null },
      lifecycleActions: [{ id: "archive", title: "Archive" }],
      titleRegenerationSupported: false,
    });

    expect(actions.map((action) => action.id)).toEqual([
      "archive",
      "thread-title-actions",
      "thread-utility-actions",
      "thread-delete-actions",
    ]);
    expect(actions[1]?.subactions?.map((action) => action.id)).toEqual(["rename"]);
    expect(actions[2]?.subactions?.map((action) => action.id)).toEqual([
      "mark-unread",
      "copy-path",
    ]);
  });

  it("disables title regeneration while one is in flight", () => {
    const actions = buildThreadListMenuActions({
      thread: {
        branch: "main",
        titleRegeneration: {
          requestId: CommandId.make("request-1"),
          startedAt: "2026-08-08T00:00:00.000Z",
        },
      },
      lifecycleActions: [],
      titleRegenerationSupported: true,
    });
    const action = actions
      .flatMap((candidate) => candidate.subactions ?? [])
      .find((candidate) => candidate.id === "regenerate-title");

    expect(action?.title).toBe("Regenerating…");
    expect(action?.attributes?.disabled).toBe(true);
  });
});
