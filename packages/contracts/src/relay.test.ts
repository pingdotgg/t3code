import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { RelayDeviceRegistrationRequest } from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it.each([
    [23, "Failure"],
    [24, "Success"],
    [37, "Success"],
  ])("enforces the Android minimum without an upper bound (API %i)", (androidApiLevel, result) => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel })._tag).toBe(result);
  });

  it("accepts Android tokens without Apple routing and preserves older iOS registrations", () => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel: 36 })._tag).toBe(
      "Success",
    );
    expect(decodeDevice({ ...device, platform: "ios", iosMajorVersion: 18 })._tag).toBe("Success");
  });
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});
