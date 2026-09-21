import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { runThreadActionShortcut } from "./threadActionShortcut";

const target = scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("thread-1"));
function event(repeat = false) {
  return { repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("runThreadActionShortcut", () => {
  it("leaves shortcuts alone without a saved thread", async () => {
    const key = event();
    const action = vi.fn(async () => {});
    await runThreadActionShortcut(key, null, { current: false }, action);
    expect(action).not.toHaveBeenCalled();
    expect(key.preventDefault).not.toHaveBeenCalled();
  });

  it("consumes held-key repeats without acting on the next thread", async () => {
    const key = event(true);
    const action = vi.fn(async () => {});
    await runThreadActionShortcut(key, target, { current: false }, action);
    expect(action).not.toHaveBeenCalled();
    expect(key.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps the original environment and thread while blocking overlapping actions", async () => {
    const pending = { current: false };
    let confirm = (_accepted: boolean) => {};
    const confirmation = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    const action = vi.fn(() => confirmation);
    const first = runThreadActionShortcut(event(), target, pending, action);
    const otherTarget = scopeThreadRef(EnvironmentId.make("other-environment"), target.threadId);
    await runThreadActionShortcut(event(), otherTarget, pending, action);
    expect(action).toHaveBeenCalledExactlyOnceWith(target);
    expect(pending.current).toBe(true);
    confirm(false);
    expect(await first).toBe(false);
    expect(pending.current).toBe(false);
    await runThreadActionShortcut(event(), otherTarget, pending, action);
    expect(action).toHaveBeenLastCalledWith(otherTarget);
  });

  it("allows a retry after the action fails", async () => {
    const pending = { current: false };
    await expect(
      runThreadActionShortcut(event(), target, pending, async () => {
        throw new Error("Disconnected");
      }),
    ).rejects.toThrow("Disconnected");
    expect(pending.current).toBe(false);
    expect(await runThreadActionShortcut(event(), target, pending, async () => "done")).toBe(
      "done",
    );
  });
});
