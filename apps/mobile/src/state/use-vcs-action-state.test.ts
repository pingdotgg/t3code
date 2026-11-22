import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock("./vcs", () => ({ vcsActionManager: {} }));

import { dismissGitActionResult, showGitActionResult } from "./use-vcs-action-state";

describe("showGitActionResult", () => {
  it("buzzes once per reported result with the matching feedback type", () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
    };
    const success = { threadRef, type: "success", title: "Pushed" } as const;
    const error = {
      threadRef,
      type: "error",
      title: "Git action failed",
      description: "rejected",
    } as const;
    const dismiss: (threadRef: ScopedThreadRef) => void = dismissGitActionResult;
    showGitActionResult(success);
    showGitActionResult(error);
    dismiss(threadRef);

    expect(mocks.notificationAsync.mock.calls).toEqual([["success"], ["error"]]);
  });
});
