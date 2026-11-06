import { describe, expect, it } from "vite-plus/test";

import { preparationPillLabel, preparationSteps } from "./preparation-progress";

const input = {
  sent: false,
  preparingWorktree: true,
  connected: true,
  environmentLabel: "Mac mini",
};

describe("preparationPillLabel", () => {
  it("does not claim setup while the task is still in the outbox", () => {
    expect(preparationPillLabel(input)).toBe("Sending task…");
  });

  it("reports setup once the server has the task", () => {
    expect(preparationPillLabel({ ...input, sent: true })).toBe("Setting up worktree…");
    expect(preparationPillLabel({ ...input, sent: true, preparingWorktree: false })).toBe(
      "Starting…",
    );
  });
});

describe("preparationSteps", () => {
  it("waits on delivery before any setup step starts", () => {
    expect(preparationSteps({ ...input, connected: false })).toMatchObject([
      { id: "send", status: "running", detail: "Waiting for connection" },
      { id: "workspace", status: "pending" },
      { id: "agent", status: "pending" },
    ]);
  });

  it("moves on to setup once the task is delivered", () => {
    expect(preparationSteps({ ...input, sent: true })).toMatchObject([
      { id: "send", label: "Send task to Mac mini", status: "done", detail: null },
      { id: "workspace", label: "Set up worktree", status: "running" },
      { id: "agent", status: "pending" },
    ]);
  });

  it.each([true, false])(
    "shows a connection wait after delivery while preparingWorktree=%s",
    (preparingWorktree) => {
      expect(
        preparationSteps({ ...input, sent: true, connected: false, preparingWorktree }),
      ).toMatchObject([
        { id: "send", status: "done", detail: null },
        { id: "workspace", status: "running", detail: "Waiting for connection" },
        { id: "agent", status: "pending", detail: null },
      ]);
    },
  );
});
