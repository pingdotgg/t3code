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
  it.each([
    { platform: "android", androidDiscoveryIncomplete: true, incompletePlatforms: [] },
    { platform: "ios", androidDiscoveryIncomplete: false, incompletePlatforms: ["ios"] },
    { platform: "android", androidDiscoveryIncomplete: false, incompletePlatforms: ["android"] },
  ] as const)("waits for complete $platform discovery before advising device setup", (input) => {
    const state = deviceState({
      hostStatus: "idle",
      hosts: [{ ...deviceState().hosts[0]!, id: "remote", kind: "ssh" }],
      hostStatuses: {
        remote: {
          status: "ready",
          detail: "Host discovery did not finish.",
          incompletePlatforms: input.incompletePlatforms,
          ...(input.androidDiscoveryIncomplete ? { androidDiscoveryIncomplete: true } : {}),
        },
      },
    });
    expect(platformSetupStatus(state, input.platform).message).toContain(
      input.androidDiscoveryIncomplete ? "may be incomplete" : "discovery reported a problem",
    );
    const otherPlatform = input.platform === "ios" ? "android" : "ios";
    expect(platformSetupStatus(state, otherPlatform).message).toContain(
      otherPlatform === "ios" ? "Xcode Settings" : "Device Manager",
    );
    expect(
      platformSetupStatus(
        {
          ...state,
          hostStatuses: {
            remote: {
              status: "ready",
              detail: "[apple-utils] A warning unrelated to listing devices.",
            },
          },
        },
        input.platform,
      ).message,
    ).toContain(input.platform === "ios" ? "Xcode Settings" : "Device Manager");
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
