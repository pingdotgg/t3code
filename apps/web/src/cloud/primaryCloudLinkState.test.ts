import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CloudLinkTarget } from "./linkEnvironment";
import {
  __resetStartupCloudLinkRefreshForTests,
  resolveManagedTunnelActive,
  scheduleStartupReconcileLinkStateRefresh,
  STARTUP_CLOUD_LINK_RECONCILE_REFRESH_MS,
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

describe("scheduleStartupReconcileLinkStateRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetStartupCloudLinkRefreshForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetStartupCloudLinkRefreshForTests();
  });

  it("replaces a startup-stale inactive switch after the follow-up refresh", () => {
    let state: { linked: boolean; managedTunnelActive?: boolean } = {
      linked: true,
      managedTunnelActive: false,
    };
    const refresh = vi.fn(() => {
      state = { linked: true, managedTunnelActive: true };
    });

    expect(resolveManagedTunnelActive(state)).toBe(false);
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(true);
    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(false);

    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    expect(resolveManagedTunnelActive(state)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(TARGET);
    expect(resolveManagedTunnelActive(state)).toBe(true);
  });

  it("does not schedule without a target", () => {
    const refresh = vi.fn();
    expect(scheduleStartupReconcileLinkStateRefresh(null, refresh)).toBe(false);
    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_MS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("schedules a separate follow-up for a different environment", () => {
    const refresh = vi.fn();
    const otherTarget = { ...TARGET, environmentId: "environment-2" };

    expect(scheduleStartupReconcileLinkStateRefresh(TARGET, refresh)).toBe(true);
    expect(scheduleStartupReconcileLinkStateRefresh(otherTarget, refresh)).toBe(true);

    vi.advanceTimersByTime(STARTUP_CLOUD_LINK_RECONCILE_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, TARGET);
    expect(refresh).toHaveBeenNthCalledWith(2, otherTarget);
  });
});
