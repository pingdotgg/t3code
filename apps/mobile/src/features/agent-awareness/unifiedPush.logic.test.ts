import { describe, expect, it } from "vite-plus/test";

import {
  unifiedPushRegistration,
  unifiedPushStatus,
  type UnifiedPushState,
} from "./unifiedPush.logic";

const base: UnifiedPushState = {
  available: true,
  distributor: "Sunup",
  enabled: true,
  endpoint: "https://push.example/up",
  keys: { p256dh: "pub", auth: "secret" },
  failure: null,
  lastMessageAt: null,
  deviceId: "device-1",
};

describe("unifiedPushStatus", () => {
  it.each([
    [null, "off"],
    [{ ...base, enabled: false }, "off"],
    [{ ...base, enabled: false, available: false }, "no-distributor"],
    [{ ...base, endpoint: null }, "waiting"],
    [{ ...base, failure: "ACTION_REQUIRED" }, "failed"],
    [base, "ready"],
  ] as const)("%j -> %s", (state, status) => {
    expect(unifiedPushStatus(state)).toBe(status);
  });
});

describe("unifiedPushRegistration", () => {
  it("names the device, endpoint and keys the servers push to", () => {
    expect(unifiedPushRegistration(base)).toEqual({
      deviceId: "device-1",
      endpoint: "https://push.example/up",
      keys: { p256dh: "pub", auth: "secret" },
    });
  });

  it.each([
    ["disabled", { ...base, enabled: false }],
    ["without an endpoint yet", { ...base, endpoint: null }],
    ["before notifications are configured", { ...base, deviceId: null }],
  ] as const)("is null when %s", (_label, state) => {
    expect(unifiedPushRegistration(state)).toBeNull();
  });

  it("omits keys for a distributor that issues none", () => {
    expect(unifiedPushRegistration({ ...base, keys: null })).not.toHaveProperty("keys");
  });
});
