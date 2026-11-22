import { describe, expect, it } from "vite-plus/test";

import {
  unifiedPushStatus,
  unifiedPushWatcherConfig,
  type UnifiedPushState,
} from "./unifiedPush.logic";

const base: UnifiedPushState = {
  available: true,
  distributor: "ntfy",
  enabled: true,
  endpoint: "http://ntfy.example/upabc",
  keys: null,
  failure: null,
  lastMessageAt: null,
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

describe("unifiedPushWatcherConfig", () => {
  it("names the endpoint, device and the fixed user id the native receiver matches", () => {
    expect(
      JSON.parse(
        unifiedPushWatcherConfig({ endpoint: "http://h/upx", deviceId: "dev-1", keys: null }),
      ),
    ).toEqual({ endpoint: "http://h/upx", deviceId: "dev-1", userId: "unifiedpush" });
  });

  it("carries the distributor's keys so the watcher can encrypt", () => {
    const keys = { p256dh: "pub", auth: "secret" };
    expect(
      JSON.parse(unifiedPushWatcherConfig({ endpoint: "https://p/x", deviceId: "d", keys })).keys,
    ).toEqual(keys);
  });
});
