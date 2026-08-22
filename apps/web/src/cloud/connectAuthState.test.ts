import type { EnvironmentConnectAuthState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isDesktopConnectAuthIdentityPending,
  shouldRetryDesktopConnectAuthState,
  startSettledPolling,
} from "./connectAuthState";

const authState = (
  overrides: Partial<EnvironmentConnectAuthState> = {},
): EnvironmentConnectAuthState => ({
  authorized: false,
  pendingLogin: false,
  authorizationUrl: null,
  accountId: null,
  identity: null,
  ...overrides,
});

describe("desktop Connect auth state retry", () => {
  it("retries before the first auth state response arrives", () => {
    expect(shouldRetryDesktopConnectAuthState(null)).toBe(true);
  });

  it("retries an authorized legacy credential until its account id is backfilled", () => {
    expect(shouldRetryDesktopConnectAuthState(authState({ authorized: true }))).toBe(true);
  });

  it("marks legacy identity backfill without changing stable load states", () => {
    expect(isDesktopConnectAuthIdentityPending(authState({ authorized: true }))).toBe(true);
    expect(isDesktopConnectAuthIdentityPending(authState())).toBe(false);
    expect(
      isDesktopConnectAuthIdentityPending(authState({ authorized: true, accountId: "user-123" })),
    ).toBe(false);
  });

  it("waits for each refresh to settle before scheduling another poll", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: (() => void) | undefined;
      let refreshCount = 0;
      const refresh = vi.fn(() => {
        refreshCount += 1;
        if (refreshCount === 1) {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve();
      });
      const stop = startSettledPolling(refresh, 3_000);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(refresh).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(2);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying once the state is stable", () => {
    expect(shouldRetryDesktopConnectAuthState(authState())).toBe(false);
    expect(
      shouldRetryDesktopConnectAuthState(authState({ authorized: true, accountId: "user-123" })),
    ).toBe(false);
  });
});
