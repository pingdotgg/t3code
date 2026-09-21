import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { showUndoToast, undoLatestThreadAction } from "./showUndoToast";
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

describe("undoLatestThreadAction", () => {
  it("runs the newest live Undo once and then reports nothing to undo", () => {
    const { options } = setup();
    const older = vi.fn(async () => AsyncResult.success(undefined));
    const newer = vi.fn(async () => AsyncResult.success(undefined));
    showUndoToast({ ...options, undo: older, claim: ThreadUndo.begin("settle", "env/a") });
    showUndoToast({ ...options, undo: newer, claim: ThreadUndo.begin("snooze", "env/b") });
    expect(undoLatestThreadAction()).toBe(true);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    expect(undoLatestThreadAction()).toBe(true);
    expect(older).toHaveBeenCalledOnce();
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("skips a superseded toast and a closed toast", () => {
    const { add, options } = setup();
    const superseded = vi.fn(async () => AsyncResult.success(undefined));
    const closed = vi.fn(async () => AsyncResult.success(undefined));
    const live = vi.fn(async () => AsyncResult.success(undefined));
    showUndoToast({ ...options, undo: live, claim: ThreadUndo.begin("archive", "env/live") });
    showUndoToast({ ...options, undo: closed, claim: ThreadUndo.begin("archive", "env/closed") });
    add.mock.calls[1]?.[0].onClose?.();
    showUndoToast({ ...options, undo: superseded, claim: ThreadUndo.begin("pin", "env/stale") });
    ThreadUndo.invalidate("pin", "env/stale");
    expect(undoLatestThreadAction()).toBe(true);
    expect(superseded).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
  });
});
