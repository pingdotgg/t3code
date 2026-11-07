import { ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  selectedThreadDevicePreview,
  thisAndroidPhone,
  threadDevicePreviews,
} from "./threadDevicePreviews";

const threadId = ThreadId.make("thread");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
    {
      id: "remote",
      kind: "ssh",
      label: "Mac mini",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
      version: "Android 16",
      booted: true,
      physical: false,
    },
    {
      hostId: "remote",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      version: "Android 15",
      booted: true,
      physical: false,
    },
  ],
  sessions: [
    {
      threadId,
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:00:00Z",
    },
    {
      threadId,
      hostId: "remote",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:01:00Z",
    },
    {
      threadId: ThreadId.make("another-thread"),
      hostId: "local",
      deviceId: "iphone",
      platform: "ios",
      openedAt: "2026-09-18T00:02:00Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

describe("thread device previews", () => {
  it("keeps device names and selection distinct when hosts have the same Android serial", () => {
    const previews = threadDevicePreviews(state, threadId, null);
    expect(previews.map((preview) => preview.name)).toEqual(["Pixel 9", "Pixel 8"]);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.description).toBe(
      "Android 15 · Mac mini",
    );
  });

  it("selects another open device when the agent closes the selected session", () => {
    const previews = threadDevicePreviews(state, threadId, null);
    const selectedKey = previews[1]!.key;
    const afterClose = threadDevicePreviews(
      { ...state, sessions: [state.sessions[0]!] },
      threadId,
      null,
    );
    expect(selectedThreadDevicePreview(afterClose, selectedKey)?.name).toBe("Pixel 9");
    expect(selectedThreadDevicePreview([], selectedKey)).toBeNull();
  });

  it("marks only the physical Android phone the app runs on as this phone", () => {
    const thisPhone = { name: "Google Pixel 7", version: "Android 17.0" };
    const withPhone: DeviceServiceState = {
      ...state,
      devices: [
        ...state.devices,
        {
          hostId: "local",
          id: "192.168.1.20:5555",
          platform: "android",
          name: "Google Pixel 7",
          version: "Android 17.0",
          booted: true,
          physical: true,
        },
        {
          hostId: "local",
          id: "emulator-5556",
          platform: "android",
          name: "Google Pixel 7",
          version: "Android 17.0",
          booted: true,
          physical: false,
        },
      ],
      sessions: [
        ...state.sessions,
        {
          threadId,
          hostId: "local",
          deviceId: "192.168.1.20:5555",
          platform: "android",
          openedAt: "2026-09-18T00:03:00Z",
        },
        {
          threadId,
          hostId: "local",
          deviceId: "emulator-5556",
          platform: "android",
          openedAt: "2026-09-18T00:04:00Z",
        },
      ],
    };
    expect(
      threadDevicePreviews(withPhone, threadId, thisPhone).map((preview) => preview.isThisPhone),
    ).toEqual([false, false, true, false]);
    expect(
      threadDevicePreviews(withPhone, threadId, null).map((preview) => preview.isThisPhone),
    ).toEqual([false, false, false, false]);
  });

  it("derives the name and version the device hub reports for this Android phone", () => {
    const pixel = {
      platform: "android",
      isDevice: true,
      manufacturer: "Google",
      modelName: "Pixel 7",
      osVersion: "17",
    };
    expect(thisAndroidPhone(pixel)).toEqual({ name: "Google Pixel 7", version: "Android 17.0" });
    expect(thisAndroidPhone({ ...pixel, platform: "ios" })).toBeNull();
    expect(thisAndroidPhone({ ...pixel, isDevice: false })).toBeNull();
    expect(thisAndroidPhone({ ...pixel, manufacturer: "", osVersion: "8.1.0" })).toEqual({
      name: "Pixel 7",
      version: "Android 8.1.0",
    });
  });
});
