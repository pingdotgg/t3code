import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  ready: true,
  queue: [] as Array<() => void>,
}));
const optOut = vi.hoisted(() => ({ optedOut: new Set<string>() }));

vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: navigation,
  whenRootNavigationReady: (navigate: () => void) =>
    navigation.ready ? navigate() : navigation.queue.push(navigate),
}));
vi.mock("./connectOnboardingOptOut", () => ({
  isConnectOnboardingOptedOut: (accountId: string) =>
    Promise.resolve(optOut.optedOut.has(accountId)),
}));

import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";

afterEach(() => {
  clearConnectOnboardingRequest();
  optOut.optedOut.clear();
  navigation.navigate.mockReset();
  navigation.ready = true;
  navigation.queue.length = 0;
  vi.useRealTimers();
});

describe("requestConnectOnboarding", () => {
  it("presents the sheet after the settle delay", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    await vi.advanceTimersByTimeAsync(599);
    expect(navigation.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith("ConnectOnboarding");
  });

  it("drops a request cleared by sign-out before it fires", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    clearConnectOnboardingRequest();
    await vi.runAllTimersAsync();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("skips accounts that opted out", async () => {
    vi.useFakeTimers();
    optOut.optedOut.add("account-1");
    requestConnectOnboarding("account-1");
    await vi.runAllTimersAsync();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("presents once when a newer request replaces a pending one", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    requestConnectOnboarding("account-2");
    await vi.runAllTimersAsync();
    expect(navigation.navigate).toHaveBeenCalledOnce();
  });

  it("drops a request cleared while it waits for navigation to be ready", async () => {
    vi.useFakeTimers();
    navigation.ready = false;
    requestConnectOnboarding("account-1");
    await vi.runAllTimersAsync();
    clearConnectOnboardingRequest();
    for (const navigate of navigation.queue.splice(0)) navigate();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
