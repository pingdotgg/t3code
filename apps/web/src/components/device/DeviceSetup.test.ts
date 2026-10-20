import type { DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deviceHostDiagnostics, deviceHubReadiness, platformSetupStatus } from "./DeviceSetup";

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
  it("directs users to install an iOS runtime and create an Android virtual device", () => {
    expect(platformSetupStatus(deviceState(), "ios").message).toContain("Xcode Settings");
    expect(platformSetupStatus(deviceState(), "android").message).toContain("Device Manager");
  });

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

  it("preserves a specific missing-tool explanation from the server", () => {
    const state = deviceState({
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
      ],
    });
    expect(platformSetupStatus(state, "android").message).toBe("Android Emulator is missing.");
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

  it("labels ready host warnings in host order and drops them once cleared", () => {
    const hosts = [
      { id: "local", label: "This machine" },
      { id: "macmini", label: "Mac Mini" },
    ];
    const state = deviceState({
      hostStatuses: {
        macmini: { status: "ready", detail: "adb is not on PATH." },
        local: { status: "ready", detail: "Xcode license not accepted." },
      },
    });
    expect(deviceHostDiagnostics(hosts, state.hostStatuses)).toEqual([
      { hostId: "local", label: "This machine", detail: "Xcode license not accepted." },
      { hostId: "macmini", label: "Mac Mini", detail: "adb is not on PATH." },
    ]);
    expect(
      deviceHostDiagnostics(hosts, {
        ...state.hostStatuses,
        local: { status: "ready" },
      }),
    ).toEqual([{ hostId: "macmini", label: "Mac Mini", detail: "adb is not on PATH." }]);
  });

  it("omits details from hosts that are not ready or not listed", () => {
    const hosts = [
      { id: "local", label: "This machine" },
      { id: "macmini", label: "Mac Mini" },
    ];
    expect(
      deviceHostDiagnostics(hosts, {
        local: { status: "failed", detail: "Device hub crashed." },
        macmini: { status: "starting", detail: "Connecting over SSH." },
        unknown: { status: "ready", detail: "Stale host warning." },
      }),
    ).toEqual([]);
  });
});
