import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { showUndoToast } from "./showUndoToast";
import * as ThreadUndo from "./threadUndo";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("undo-toast");
  const close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
  const undo = vi.fn(async () => AsyncResult.success(undefined));
  const claim = ThreadUndo.begin("pin", "env/thread");
  const options = {
    title: "Thread unpinned",
    description: "Thread",
    failureTitle: "Restore failed",
    undo,
    claim,
  };
  return { add, close, undo, claim, options };
}

function click(add: ReturnType<typeof setup>["add"], index = 0) {
  const handler = add.mock.calls[index]?.[0].actionProps?.onClick;
  if (!handler) throw new Error("Undo action is missing");
  return handler({} as Parameters<typeof handler>[0]);
}

describe("showUndoToast", () => {
  it("ignores a stale toast and lets the latest action run only once", async () => {
    const { add, close, undo, options } = setup();
    showUndoToast(options);
    ThreadUndo.invalidate("pin", "env/thread");
    showUndoToast({ ...options, claim: ThreadUndo.begin("pin", "env/thread") });
    await click(add);
    expect(undo).not.toHaveBeenCalled();
    await click(add, 1);
    await click(add, 1);
    expect(undo).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledExactlyOnceWith("undo-toast");
  });

  it("releases the claim on close and rejects a later click", async () => {
    const { add, undo, claim, options } = setup();
    showUndoToast(options);
    add.mock.calls[0]?.[0].onClose?.();
    expect(claim.isCurrent()).toBe(false);
    await click(add);
    expect(undo).not.toHaveBeenCalled();
  });

  it("does not show a toast for a late completion after a newer action", () => {
    const { add, options } = setup();
    ThreadUndo.invalidate("pin", "env/thread");
    showUndoToast(options);
    expect(add).not.toHaveBeenCalled();
  });

  it("reports a failed restore and releases its claim", async () => {
    const { add, claim, options } = setup();
    showUndoToast({
      ...options,
      undo: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    await click(add);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", title: "Restore failed", description: "offline" }),
    );
    expect(claim.isCurrent()).toBe(false);
  });

  it("reports a rejected restore promise", async () => {
    const { add, options } = setup();
    showUndoToast({
      ...options,
      undo: async () => {
        throw new Error("disconnected");
      },
    });
    await click(add);
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: "disconnected" }),
    );
  });

  it("does not report interrupted restores as errors", async () => {
    const { add, options } = setup();
    showUndoToast({ ...options, undo: async () => AsyncResult.failure(Cause.interrupt()) });
    await click(add);
    expect(add).toHaveBeenCalledOnce();
  });
});
