import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldLeavePutAwayThread } from "./thread-put-away-navigation";

const thread = { environmentId: EnvironmentId.make("env-a"), id: ThreadId.make("thread-a") };
const shown = { environmentId: "env-a", threadId: "thread-a" };
const base = { succeeded: true, usesSplitView: false, focused: true, routeParams: shown, thread };

describe("shouldLeavePutAwayThread", () => {
  it("returns to the list after a successful Settle or Snooze", () => {
    expect(shouldLeavePutAwayThread(base)).toBe(true);
    expect(
      shouldLeavePutAwayThread({
        ...base,
        routeParams: { environmentId: ["env-a"], threadId: ["thread-a"] },
      }),
    ).toBe(true);
  });

  it("keeps the thread open when the action failed", () => {
    expect(shouldLeavePutAwayThread({ ...base, succeeded: false })).toBe(false);
  });

  it("keeps the thread open in a split view, where the list is on screen", () => {
    expect(shouldLeavePutAwayThread({ ...base, usesSplitView: true })).toBe(false);
  });

  it("stays put after the user moved on while the action was in flight", () => {
    expect(shouldLeavePutAwayThread({ ...base, focused: false })).toBe(false);
    expect(
      shouldLeavePutAwayThread({
        ...base,
        routeParams: { environmentId: "env-a", threadId: "thread-b" },
      }),
    ).toBe(false);
    expect(shouldLeavePutAwayThread({ ...base, routeParams: undefined })).toBe(false);
  });
});
