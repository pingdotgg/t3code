import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPermissionPoller } from "./usePermissionStatus";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPermissionPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks on subscribe and on every interval, publishing each result", async () => {
    const onChange = vi.fn();
    let granted = false;
    const check = vi.fn(async () => ({ screen: granted }));
    const poller = createPermissionPoller(check, { screen: false });
    const stop = poller.subscribe(onChange);

    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    granted = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(check).toHaveBeenCalledTimes(2);
    expect(poller.getSnapshot()).toEqual({ status: { screen: true }, error: null });
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("never overlaps checks while one is still pending", async () => {
    const pending = deferred<{ screen: boolean }>();
    const check = vi.fn(() => pending.promise);
    const poller = createPermissionPoller(check, { screen: false });
    const stop = poller.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(4500);
    expect(check).toHaveBeenCalledTimes(1);
    pending.resolve({ screen: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the last status on failure and clears the error on the next success", async () => {
    let fail = false;
    const check = vi.fn(async () => {
      if (fail) throw new Error("unavailable");
      return { screen: true };
    });
    const poller = createPermissionPoller(check, { screen: false });
    const stop = poller.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(poller.getSnapshot().status).toEqual({ screen: true });
    expect(poller.getSnapshot().error).not.toBeNull();
    fail = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(poller.getSnapshot().error).toBeNull();
    stop();
  });

  it("drops a result that lands after unsubscribing", async () => {
    const pending = deferred<{ screen: boolean }>();
    const onChange = vi.fn();
    const poller = createPermissionPoller(() => pending.promise, { screen: false });
    const stop = poller.subscribe(onChange);

    stop();
    pending.resolve({ screen: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(poller.getSnapshot().status).toEqual({ screen: false });
  });
});
