import { EnvironmentId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createFileSaveSessions,
  type FileSaveSessionDeps,
  type FileSaveTarget,
} from "./fileSaveSessions";

const target: FileSaveTarget = {
  environmentId: EnvironmentId.make("file-save-sessions"),
  cwd: "/workspace",
  relativePath: "file.txt",
};

function setup() {
  vi.useFakeTimers();
  const state = {
    writable: true,
    unsaved: null as string | null,
    onWritable: [] as Array<() => void>,
  };
  const persist = vi.fn<FileSaveSessionDeps["persist"]>(async () => AsyncResult.success(undefined));
  const confirm = vi.fn((_target: FileSaveTarget, _contents: string) => true);
  const onPendingChange = vi.fn();
  const sessions = createFileSaveSessions({
    debounceMs: 500,
    canPersist: () => state.writable,
    subscribeWritable: (_target, onWritable) => {
      state.onWritable.push(onWritable);
      return () => {
        state.onWritable = state.onWritable.filter((listener) => listener !== onWritable);
      };
    },
    persist,
    confirm,
    readUnsaved: () => state.unsaved,
  });
  const writes = () => persist.mock.calls.map(([written, contents]) => [written, contents]);
  return {
    state,
    sessions,
    persist,
    confirm,
    onPendingChange,
    writes,
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

describe("file save sessions", () => {
  it("debounces edits and clears the pending marker once confirmed", async () => {
    using h = setup();
    h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "a");
    h.sessions.change(target, "ab");
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.writes()).toEqual([[target, "ab"]]);
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("flushes on the last release and drops edits from retired editors", async () => {
    using h = setup();
    const releaseFirst = h.sessions.acquire(target, h.onPendingChange);
    const releaseSecond = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "pending edit");
    releaseFirst();
    expect(h.persist).not.toHaveBeenCalled();
    releaseSecond();
    h.sessions.change(target, "stale editor contents");
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([[target, "pending edit"]]);
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("gives a replaced file a fresh session and flushes the old one", async () => {
    using h = setup();
    const other = { ...target, relativePath: "other.txt" };
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "old file edit");
    release();
    h.sessions.acquire(other, h.onPendingChange);
    h.sessions.change(target, "stale editor contents");
    h.sessions.change(other, "new file edit");
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([
      [target, "old file edit"],
      [other, "new file edit"],
    ]);
  });

  it("resumes an unsaved draft when a session is created", async () => {
    using h = setup();
    h.state.unsaved = "pending draft";
    h.sessions.acquire(target, h.onPendingChange);
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.writes()).toEqual([[target, "pending draft"]]);
  });

  it("does not queue a draft that a retired session is still writing", async () => {
    using h = setup();
    let finishWrite = () => {};
    h.persist.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(AsyncResult.success(undefined));
        }),
    );
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "draft");
    h.state.unsaved = "draft";
    release();
    // A StrictMode ref replay reacquires while the flush is in flight.
    h.sessions.acquire(target, h.onPendingChange);
    finishWrite();
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([[target, "draft"]]);
  });

  it("writes a rejoining surface's edit last, over the released session's queued draft", async () => {
    using h = setup();
    let finishWrite = () => {};
    h.persist.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(AsyncResult.success(undefined));
        }),
    );
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "X");
    await vi.advanceTimersByTimeAsync(500);
    h.sessions.change(target, "Y");
    release();
    h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "Z");
    await vi.advanceTimersByTimeAsync(500);
    finishWrite();
    await vi.runAllTimersAsync();
    expect(h.writes().at(-1)).toEqual([target, "Z"]);
  });

  it("tells a surface joining a session with an unsaved edit that the file is pending", () => {
    using h = setup();
    h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "edit");
    const joiningListener = vi.fn();
    h.sessions.acquire(target, joiningListener);
    expect(joiningListener).toHaveBeenCalledWith("file.txt", true);
  });

  it("lets go of a released session that cannot write and recovers its draft later", async () => {
    using h = setup();
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.state.writable = false;
    h.sessions.change(target, "draft");
    h.state.unsaved = "draft";
    release();
    expect(h.state.onWritable).toEqual([]);
    h.sessions.change(target, "retired editor contents");
    h.state.writable = true;
    h.sessions.acquire(target, h.onPendingChange);
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([[target, "draft"]]);
  });

  it("recovers a draft that a retired session gave up on when write access dropped", async () => {
    using h = setup();
    let finishWrite = () => {};
    h.persist.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(AsyncResult.success(undefined));
        }),
    );
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "X");
    await vi.advanceTimersByTimeAsync(500);
    h.sessions.change(target, "Y");
    release();
    h.state.writable = false;
    finishWrite();
    await vi.runAllTimersAsync();
    h.state.unsaved = "Y";
    h.sessions.acquire(target, h.onPendingChange);
    h.state.writable = true;
    for (const onWritable of h.state.onWritable) onWritable();
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([
      [target, "X"],
      [target, "Y"],
    ]);
  });

  it("stops notifying a surface's listener once it releases a shared session", async () => {
    using h = setup();
    const retiredListener = vi.fn();
    const release = h.sessions.acquire(target, retiredListener);
    h.sessions.acquire(target, h.onPendingChange);
    release();
    h.sessions.change(target, "edit");
    await vi.runAllTimersAsync();
    expect(retiredListener).not.toHaveBeenCalled();
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("requeues a draft whose retired flush failed on the live session", async () => {
    using h = setup();
    let failWrite = () => {};
    h.persist.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          failWrite = () => resolve(AsyncResult.failure(Cause.fail("offline")));
        }),
    );
    const release = h.sessions.acquire(target, h.onPendingChange);
    h.sessions.change(target, "draft");
    h.state.unsaved = "draft";
    release();
    h.sessions.acquire(target, h.onPendingChange);
    failWrite();
    await vi.runAllTimersAsync();
    expect(h.writes()).toEqual([
      [target, "draft"],
      [target, "draft"],
    ]);
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("keeps edits pending while unwritable and resumes them when access returns", async () => {
    using h = setup();
    h.sessions.acquire(target, h.onPendingChange);
    h.state.writable = false;
    h.sessions.change(target, "pending edit");
    h.state.unsaved = "pending edit";
    await vi.runAllTimersAsync();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", true);

    h.state.writable = true;
    for (const onWritable of h.state.onWritable) onWritable();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.writes()).toEqual([[target, "pending edit"]]);
    expect(h.onPendingChange).toHaveBeenLastCalledWith("file.txt", false);
  });

  it("skips recovery while unwritable and stops watching access after release", async () => {
    using h = setup();
    h.state.writable = false;
    h.state.unsaved = "pending draft";
    const release = h.sessions.acquire(target, h.onPendingChange);
    expect(h.onPendingChange).not.toHaveBeenCalled();
    release();
    expect(h.state.onWritable).toEqual([]);
    await vi.runAllTimersAsync();
    expect(h.persist).not.toHaveBeenCalled();
  });
});
