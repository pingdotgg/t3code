import { describe, expect, it } from "vite-plus/test";

import {
  resolveOnboardingReconcileDesired,
  shouldSyncOnboardingToggleFromLinkState,
} from "./connectOnboarding";

describe("shouldSyncOnboardingToggleFromLinkState", () => {
  it("resyncs an untouched toggle for the account being onboarded", () => {
    expect(
      shouldSyncOnboardingToggleFromLinkState({
        touched: false,
        openForAccount: "user-1",
        linked: true,
        cloudUserId: "user-1",
      }),
    ).toBe(true);
  });

  it("does not overwrite a toggle the user has already changed", () => {
    expect(
      shouldSyncOnboardingToggleFromLinkState({
        touched: true,
        openForAccount: "user-1",
        linked: true,
        cloudUserId: "user-1",
      }),
    ).toBe(false);
  });

  it("ignores link state from another account", () => {
    expect(
      shouldSyncOnboardingToggleFromLinkState({
        touched: false,
        openForAccount: "user-1",
        linked: true,
        cloudUserId: "user-2",
      }),
    ).toBe(false);
  });
});

describe("resolveOnboardingReconcileDesired", () => {
  it("does not tear down an active tunnel after a stale inactive prefill", () => {
    expect(
      resolveOnboardingReconcileDesired({
        exposeEnvironment: false,
        publishAgentActivity: true,
        managedTunnelActive: true,
      }),
    ).toEqual({ managedTunnel: true, publish: true });
  });

  it("skips reconcile when nothing would be enabled", () => {
    expect(
      resolveOnboardingReconcileDesired({
        exposeEnvironment: false,
        publishAgentActivity: false,
        managedTunnelActive: false,
      }),
    ).toBeNull();
  });

  it("keeps an explicit request to enable the managed tunnel", () => {
    expect(
      resolveOnboardingReconcileDesired({
        exposeEnvironment: true,
        publishAgentActivity: false,
        managedTunnelActive: false,
      }),
    ).toEqual({ managedTunnel: true, publish: false });
  });
});
