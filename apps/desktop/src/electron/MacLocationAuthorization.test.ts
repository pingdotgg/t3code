import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ status: 0, requests: 0, statusUnavailable: false }));
vi.mock("ffi-rs", () => ({
  DataType: { BigInt: 16, String: 0, I32: 1, Void: 7 },
  open: () => {},
  load: ({ retType }: { retType: number }) => {
    if (retType === 1) {
      if (native.statusUnavailable) throw new Error("native API unavailable");
      return native.status;
    }
    if (retType === 7) {
      native.requests += 1;
      return undefined;
    }
    return 1n;
  },
}));

import { loadMacLocationAuthorization } from "./MacLocationAuthorization.ts";

describe("macOS location authorization", () => {
  let authorization: Awaited<ReturnType<typeof loadMacLocationAuthorization>>;
  beforeEach(async () => {
    native.status = 0;
    native.requests = 0;
    native.statusUnavailable = false;
    vi.useFakeTimers();
    authorization = await loadMacLocationAuthorization();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([3, 4])("accepts existing authorization %s without another prompt", async (status) => {
    native.status = status;
    expect(await authorization.request()).toBe(true);
    expect(authorization.isAuthorized()).toBe(true);
    expect(native.requests).toBe(0);
  });

  it.each([1, 2])(
    "returns restricted or denied authorization %s without prompting",
    async (status) => {
      native.status = status;
      expect(await authorization.request()).toBe(false);
      expect(authorization.isAuthorized()).toBe(false);
      expect(native.requests).toBe(0);
    },
  );

  it("waits for macOS authorization before allowing location acquisition", async () => {
    const outcome = vi.fn();
    const request = authorization.request().then(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.requests).toBe(1);
    expect(outcome).not.toHaveBeenCalled();
    expect(authorization.isAuthorized()).toBe(false);

    native.status = 3;
    await vi.advanceTimersByTimeAsync(250);
    await request;
    expect(outcome).toHaveBeenCalledWith(true);
    expect(authorization.isAuthorized()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares a pending system prompt and applies denial to all waiting requests", async () => {
    const first = authorization.request();
    const second = authorization.request();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.requests).toBe(1);

    native.status = 2;
    await vi.advanceTimersByTimeAsync(250);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(authorization.isAuthorized()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("denies an unanswered system prompt and releases its timers", async () => {
    const request = authorization.request();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await request).toBe(false);
    expect(authorization.isAuthorized()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    native.status = 3;
    expect(await authorization.request()).toBe(true);
  });

  it("shares a retry after timeout while authorization is still undetermined", async () => {
    const first = authorization.request();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await first).toBe(false);
    expect(native.status).toBe(0);
    expect(native.requests).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    const retry = authorization.request();
    const concurrentRetry = authorization.request();
    expect(retry).toBe(concurrentRetry);
    await vi.advanceTimersByTimeAsync(250);
    expect(native.requests).toBe(2);
    expect(authorization.isAuthorized()).toBe(false);

    native.status = 4;
    await vi.advanceTimersByTimeAsync(250);
    expect(await Promise.all([retry, concurrentRetry])).toEqual([true, true]);
    expect(authorization.isAuthorized()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reflects revocation and restoration without another request", () => {
    native.status = 3;
    expect(authorization.isAuthorized()).toBe(true);
    native.status = 2;
    expect(authorization.isAuthorized()).toBe(false);
    native.status = 4;
    expect(authorization.isAuthorized()).toBe(true);
    expect(native.requests).toBe(0);
  });

  it("denies an unavailable status reader without throwing from a permission check", () => {
    native.statusUnavailable = true;
    expect(authorization.isAuthorized()).toBe(false);
  });

  it("releases the pending request and timers after a native status failure", async () => {
    const result = authorization.request().catch(() => false);
    await vi.advanceTimersByTimeAsync(0);
    native.statusUnavailable = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    native.statusUnavailable = false;
    native.status = 3;
    expect(await authorization.request()).toBe(true);
  });
});
