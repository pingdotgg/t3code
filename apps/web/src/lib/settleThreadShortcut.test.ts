import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { claimSettleThreadShortcut } from "./settleThreadShortcut";

const routeThreadRef = {
  environmentId: EnvironmentId.make("environment-id"),
  threadId: ThreadId.make("thread-id"),
};

function shortcutEvent(repeat = false) {
  return {
    repeat,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("settle thread shortcut", () => {
  it("claims the shortcut when there is no route thread", () => {
    const event = shortcutEvent();

    expect(claimSettleThreadShortcut(event, null)).toBeNull();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("returns the route thread for a non-repeated shortcut", () => {
    const event = shortcutEvent();

    expect(claimSettleThreadShortcut(event, routeThreadRef)).toBe(routeThreadRef);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("claims repeated shortcuts without returning the route thread", () => {
    const event = shortcutEvent(true);

    expect(claimSettleThreadShortcut(event, routeThreadRef)).toBeNull();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
