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
      "rename",
      "regenerate-title",
      "delete",
    ]);
    expect(actions[0]?.title).toBe("New thread on feature/mobile-menu");
  });

  it("gates title regeneration and the branch action", () => {
    const actions = buildThreadListMenuActions({
      thread: { branch: null, titleRegeneration: null },
      lifecycleActions: [{ id: "archive", title: "Archive" }],
      titleRegenerationSupported: false,
    });

    expect(actions.map((action) => action.id)).toEqual(["archive", "rename", "delete"]);
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
    const action = actions.find((candidate) => candidate.id === "regenerate-title");

    expect(action?.title).toBe("Regenerating…");
    expect(action?.attributes?.disabled).toBe(true);
  });
});
