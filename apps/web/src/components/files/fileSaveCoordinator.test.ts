import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred<E = never>() {
  let resolve!: (result: AtomCommandResult<void, E>) => void;
  const promise = new Promise<AtomCommandResult<void, E>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("FileSaveCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits and persists only the latest contents", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(499);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("latest");
    expect(onConfirmed).toHaveBeenCalledWith("latest");
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    vi.useFakeTimers();
    const firstWrite = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    firstWrite.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved");
  });

  it.each([false, true])(
    "keeps an edit pending after write permission is removed (closing=%s)",
    async (closeEditor) => {
      vi.useFakeTimers();
      let canWrite = true;
      const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
      const onPendingChange = vi.fn();
      const coordinator = new FileSaveCoordinator({
        debounceMs: 500,
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: vi.fn(),
      });

      coordinator.change("unsaved");
      canWrite = false;
      if (closeEditor) coordinator.dispose();
      await vi.runAllTimersAsync();

      expect(persist).not.toHaveBeenCalled();
      expect(onPendingChange).toHaveBeenLastCalledWith(true);
    },
  );

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("first");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("does not rewrite a write that lands while the editor closes", async () => {
    vi.useFakeTimers();
    const inFlight = deferred();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("only");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.dispose();
    inFlight.resolve(AsyncResult.success(undefined));
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
  });

  it("retries a failed write when the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledOnce();

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write failed")))),
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("latest");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(onPendingChange).toHaveBeenCalledWith(true);
    expect(onPendingChange).not.toHaveBeenCalledWith(false);
  });

  it("retries a close-time flush when the in-flight write fails", async () => {
    vi.useFakeTimers();
    const inFlight = deferred<Error>();
    const persist = vi
      .fn()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("only");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);

    // The editor closes while the write is still in flight; the write then fails.
    coordinator.dispose();
    inFlight.resolve(AsyncResult.failure(Cause.fail(new Error("write failed"))));
    await vi.advanceTimersByTimeAsync(500);
    // The failed close-time flush must be retried, not dropped.
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith("only");

    await vi.advanceTimersByTimeAsync(999);
    expect(persist).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(onConfirmed).toHaveBeenCalledWith("only");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("retries a dispose-time flush that fails after the editor closes", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const onConfirmed = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();
    // First dispose flush failed; it must be retried instead of dropping the edit.
    expect(persist.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(persist).toHaveBeenLastCalledWith("unsaved");
    expect(onConfirmed).toHaveBeenCalledWith("unsaved");
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false]);
  });

  it("skips a closed editor retry after another edit replaces its draft", async () => {
    vi.useFakeTimers();
    let currentDraft = "old";
    const persist = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))))
      .mockResolvedValue(AsyncResult.success(undefined));
    const shouldRetryAfterClose = vi.fn((contents: string) => contents === currentDraft);
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      shouldRetryAfterClose,
    });

    coordinator.change("old");
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    currentDraft = "new";
    await vi.advanceTimersByTimeAsync(500);

    expect(shouldRetryAfterClose).toHaveBeenCalledWith("old");
    expect(persist).toHaveBeenCalledExactlyOnceWith("old");
  });

  it("caps close-time retries with backoff and preserves an unsaved draft", async () => {
    vi.useFakeTimers();
    const onPendingChange = vi.fn();
    const persist = vi
      .fn()
      .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("write unavailable"))));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(persist).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(persist).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(persist).toHaveBeenCalledTimes(4);
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
  });

  it("stops retrying if write permission was revoked after the failure", async () => {
    vi.useFakeTimers();
    let canWrite = true;
    const persist = vi.fn().mockImplementation(async () => {
      canWrite = false;
      return AsyncResult.failure(Cause.fail(new Error("write forbidden")));
    });
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      canPersist: () => canWrite,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("unsaved");
    coordinator.dispose();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("ignores editor changes emitted after disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    });

    coordinator.dispose();
    coordinator.change("stale contents");
    await vi.runAllTimersAsync();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  it("does not persist confirmed contents again on disposal", async () => {
    vi.useFakeTimers();
    const persist = vi
      .fn<(contents: string) => Promise<AtomCommandResult<void, never>>>()
      .mockResolvedValue(AsyncResult.success(undefined));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    coordinator.change("temporary edit");
    await vi.advanceTimersByTimeAsync(500);
    coordinator.change("original contents");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(2);

    coordinator.dispose();
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledTimes(2);
  });
});
