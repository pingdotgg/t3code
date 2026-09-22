import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import {
  showThreadUndoNotice,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "./showThreadUndoNotice";
import * as ThreadUndo from "./threadUndo";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("error-toast");
  const undo = vi.fn(async () => AsyncResult.success(undefined));
  const claim = ThreadUndo.begin("pin", "env/thread");
  const options = { action: "Unpinned" as const, failureTitle: "Restore failed", undo, claim };
  return { add, undo, claim, options };
}

function notice() {
  const value = useThreadUndoNotice.getState().notice;
  if (!value) throw new Error("Undo notice is missing");
  return value;
}

describe("thread undo notice", () => {
  it("aggregates consecutive actions without success toasts and restores the group once", async () => {
    const { add, undo, options } = setup();
    showThreadUndoNotice({
      ...options,
      action: "Settled",
      claim: ThreadUndo.begin("settle", "env/a"),
    });
    showThreadUndoNotice({
      ...options,
      action: "Settled",
      claim: ThreadUndo.begin("settle", "env/b"),
    });
    expect(notice()).toMatchObject({ action: "Settled", count: 2 });
    expect(add).not.toHaveBeenCalled();
    const group = notice();
    await group.undo();
    await group.undo();
    expect(undo).toHaveBeenCalledTimes(2);
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("drops invalidated claims immediately and rejects a captured stale undo", async () => {
    const { undo, options } = setup();
    showThreadUndoNotice(options);
    const stale = notice();
    ThreadUndo.invalidate("pin", "env/thread");
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/thread") });
    await stale.undo();
    expect(undo).not.toHaveBeenCalled();
    await notice().undo();
    expect(undo).toHaveBeenCalledOnce();
  });

  it("does not show a notice for a late completion after a newer action", () => {
    const { add, options } = setup();
    ThreadUndo.invalidate("pin", "env/thread");
    showThreadUndoNotice(options);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it("keeps the group available until five seconds after the latest action", async () => {
    const { undo, claim, options } = setup();
    showThreadUndoNotice(options);
    vi.advanceTimersByTime(4_000);
    const second = ThreadUndo.begin("pin", "env/second");
    showThreadUndoNotice({ ...options, claim: second });
    const group = notice();
    vi.advanceTimersByTime(4_999);
    expect(notice().count).toBe(2);
    vi.advanceTimersByTime(1);
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    expect(claim.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    await group.undo();
    expect(undo).not.toHaveBeenCalled();
  });

  it("reports a failed restore and releases its claim", async () => {
    const { add, claim, options } = setup();
    showThreadUndoNotice({
      ...options,
      undo: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    await notice().undo();
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", title: "Restore failed", description: "offline" }),
    );
    expect(claim.isCurrent()).toBe(false);
  });

  it("reports a rejected restore promise", async () => {
    const { add, options } = setup();
    showThreadUndoNotice({
      ...options,
      undo: async () => {
        throw new Error("disconnected");
      },
    });
    await notice().undo();
    expect(add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", description: "disconnected" }),
    );
  });

  it("does not report interrupted restores as errors", async () => {
    const { add, options } = setup();
    showThreadUndoNotice({ ...options, undo: async () => AsyncResult.failure(Cause.interrupt()) });
    await notice().undo();
    expect(add).not.toHaveBeenCalled();
  });

  it("undoes the latest kind first, then reveals the preceding group", async () => {
    const { options } = setup();
    const older = vi.fn(async () => AsyncResult.success(undefined));
    const newer = vi.fn(async () => AsyncResult.success(undefined));
    showThreadUndoNotice({
      ...options,
      action: "Settled",
      undo: older,
      claim: ThreadUndo.begin("settle", "env/a"),
    });
    showThreadUndoNotice({
      ...options,
      action: "Snoozed",
      undo: newer,
      claim: ThreadUndo.begin("snooze", "env/b"),
    });
    expect(undoLatestThreadAction()).toBe(true);
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    expect(notice().action).toBe("Settled");
    await notice().undo();
    expect(older).toHaveBeenCalledOnce();
    expect(undoLatestThreadAction()).toBe(false);
  });
});
