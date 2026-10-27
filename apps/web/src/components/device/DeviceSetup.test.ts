import type { DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deviceHubReadiness, platformSetupStatus } from "./DeviceSetup";

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("waits for complete Android discovery before advising creation of an AVD", () => {
    const state = deviceState({
      hostStatus: "idle",
      hosts: [{ ...deviceState().hosts[0]!, id: "remote", kind: "ssh" }],
      hostStatuses: { remote: { status: "ready", androidDiscoveryIncomplete: true } },
    });
    expect(platformSetupStatus(state, "android").message).toContain("may be incomplete");
    expect(platformSetupStatus(state, "ios").message).toContain("Xcode Settings");
    expect(
      platformSetupStatus({ ...state, hostStatuses: { remote: { status: "ready" } } }, "android")
        .message,
    ).toContain("Device Manager");
  });

  it("does not blame a missing runtime when device discovery reported a problem", () => {
    const failed = deviceState({
      hostStatusDetail: "[apple-utils] Failed to run `xcrun simctl list devices --json`:",
      hostStatuses: {
        local: {
          status: "ready",
          detail: "[apple-utils] Failed to run `xcrun simctl list devices --json`:",
        },
      },
    });
    expect(platformSetupStatus(failed, "ios")).toEqual({
      ready: false,
      message: "No iOS devices were listed because device discovery reported a problem.",
    });
    expect(platformSetupStatus(failed, "android").message).toContain("Device Manager");
    const androidFailure = deviceState({
      hostStatuses: {
        local: { status: "ready", detail: "[android-utils] Failed to run `avdmanager list avd`:" },
      },
    });
    expect(platformSetupStatus(androidFailure, "ios").message).toContain("Xcode Settings");
    expect(platformSetupStatus(androidFailure, "android").message).toContain("discovery reported");
    expect(platformSetupStatus(deviceState(), "ios").message).toContain("Xcode Settings");
  });

  it("reports an unanswered hub for either platform", () => {
    const state = deviceState({
      hostStatusDetail:
        "The device hub did not answer within 40 seconds. Devices found earlier stay listed.",
    });
    expect(platformSetupStatus(state, "ios").message).toContain("discovery reported");
    expect(platformSetupStatus(state, "android").message).toContain("discovery reported");
  });

  it("counts a remote device host when this machine has no simulator tooling", () => {
    const state = deviceState({
      hostStatus: "idle",
      hostStatuses: { macmini: { status: "ready" } },
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: false, reason: "Xcode was not found." },
            { platform: "android", available: false, reason: "Android SDK was not found." },
          ],
        },
        {
          id: "macmini",
          kind: "ssh",
          label: "Mac Mini",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android SDK was not found." },
          ],
        },
      ],
      devices: [
        {
          hostId: "macmini",
          id: "iphone",
          platform: "ios",
          name: "iPhone 16 Pro",
          version: "iOS 27.0",
          booted: true,
          physical: false,
        },
      ],
    });
    expect(deviceHubReadiness(state).ready).toBe(true);
    expect(platformSetupStatus(state, "ios")).toEqual({
      ready: true,
      message: "Xcode and iOS Simulator are available on Mac Mini.",
    });
    expect(platformSetupStatus(state, "android").ready).toBe(false);
  });
});
