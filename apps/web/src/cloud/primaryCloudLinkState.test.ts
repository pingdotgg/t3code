import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CloudLinkTarget } from "./linkEnvironment";
import {
  __resetStartupCloudLinkRefreshForTests,
  CONNECTIONS_CLOUD_LINK_RETRY_BUDGET_MS,
  resolveManagedTunnelActive,
  scheduleStartupReconcileLinkStateRefresh,
  shouldContinueConnectionsCloudLinkRetry,
  STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS,
  stopStartupReconcileLinkStateRefresh,
} from "./primaryCloudLinkState";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

describe("resolveManagedTunnelActive", () => {
  it("falls back to linked when older servers omit managedTunnelActive", () => {
    expect(resolveManagedTunnelActive({ linked: true })).toBe(true);
    expect(resolveManagedTunnelActive({ linked: false })).toBe(false);
  });

  it("does not treat a publish-only or pre-reconcile link as an active tunnel", () => {
    expect(resolveManagedTunnelActive({ linked: true, managedTunnelActive: false })).toBe(false);
  });

  it("is inactive when link state has not loaded", () => {
    expect(resolveManagedTunnelActive(null)).toBe(false);
    expect(resolveManagedTunnelActive(undefined)).toBe(false);
  });
});

describe("shouldContinueConnectionsCloudLinkRetry", () => {
  it("stops once the managed tunnel is active", () => {
    expect(shouldContinueConnectionsCloudLinkRetry(0, true)).toBe(false);
  });

  it("retries while inactive inside the budget and stops after it", () => {
    expect(shouldContinueConnectionsCloudLinkRetry(0, false)).toBe(true);
    expect(
      shouldContinueConnectionsCloudLinkRetry(CONNECTIONS_CLOUD_LINK_RETRY_BUDGET_MS - 1, false),
    ).toBe(true);
    expect(
      shouldContinueConnectionsCloudLinkRetry(CONNECTIONS_CLOUD_LINK_RETRY_BUDGET_MS, false),
    ).toBe(false);
  });
});

describe("scheduleStartupReconcileLinkStateRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetStartupCloudLinkRefreshForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetStartupCloudLinkRefreshForTests();
  });

  it("replaces a startup-stale inactive switch across the bounded refresh series", () => {
    let state: { linked: boolean; managedTunnelActive?: boolean } = {
      linked: true,
      managedTunnelActive: false,
    };
    const refresh = vi.fn(() => {
      if (refresh.mock.calls.length >= 2) {
        state = { linked: true, managedTunnelActive: true };
      }
    });

    expect(resolveManagedTunnelActive(state)).toBe(false);
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(true);
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(false);

    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[0] - 1);
    expect(refresh).not.toHaveBeenCalled();
    expect(resolveManagedTunnelActive(state)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resolveManagedTunnelActive(state)).toBe(false);

    vi.advanceTimersByTime(
      STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[1] -
        STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[0],
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(resolveManagedTunnelActive(state)).toBe(true);

    vi.advanceTimersByTime(
      STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[2] -
        STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[1],
    );
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenNthCalledWith(1, TARGET);
    expect(refresh).toHaveBeenNthCalledWith(2, TARGET);
    expect(refresh).toHaveBeenNthCalledWith(3, TARGET);
  });

  it("cancels remaining startup refreshes once the tunnel is active", () => {
    const refresh = vi.fn();
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(true);

    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(1);

    stopStartupReconcileLinkStateRefresh(TARGET);
    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[2]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(false);
  });

  it("does not schedule without a target", () => {
    const refresh = vi.fn();
    expect(scheduleStartupReconcileLinkStateRefresh(null, refresh)).toBe(false);
    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[2]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("schedules a separate follow-up for a different environment", () => {
    const refresh = vi.fn();
    const otherTarget = { ...TARGET, environmentId: "environment-2" };

    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(true);
    expect(scheduleStartupReconcileLinkStateRefresh(otherTarget, refresh)).toBe(true);

    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_DELAYS_MS[0]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, TARGET);
    expect(refresh).toHaveBeenNthCalledWith(2, otherTarget);
  });
});
