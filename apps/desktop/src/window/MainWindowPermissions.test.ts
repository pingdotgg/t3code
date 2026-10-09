import { describe, expect, it } from "vite-plus/test";

import { decideMainWindowMediaRequest, isAppUrl } from "./MainWindowPermissions.ts";

const APP_URL = "t3code://app/";

function decide(overrides: Partial<Parameters<typeof decideMainWindowMediaRequest>[0]> = {}) {
  return decideMainWindowMediaRequest({
    requestingUrl: "t3code://app/threads/abc",
    appUrl: APP_URL,
    mediaTypes: ["audio"],
    platform: "darwin",
    microphoneStatus: () => "granted",
    ...overrides,
  });
}

describe("isAppUrl", () => {
  it("matches the app shell and nothing that merely shares its prefix", () => {
    expect(isAppUrl("t3code://app", APP_URL)).toBe(true);
    expect(isAppUrl("t3code://app/settings", APP_URL)).toBe(true);
    expect(isAppUrl("t3code://application/", APP_URL)).toBe(false);
    expect(isAppUrl("https://example.com/", APP_URL)).toBe(false);
    expect(isAppUrl(undefined, APP_URL)).toBe(false);
  });
});

describe("decideMainWindowMediaRequest", () => {
  it("denies media to frames outside the app shell", () => {
    expect(decide({ requestingUrl: "https://example.com/embed" })).toBe("deny");
  });

  it("asks macOS for the microphone until the user has granted it", () => {
    expect(decide({ microphoneStatus: () => "not-determined" })).toBe("ask-microphone");
    expect(decide({ microphoneStatus: () => "denied" })).toBe("ask-microphone");
    expect(decide()).toBe("grant");
  });

  it("grants the microphone directly off macOS", () => {
    expect(decide({ platform: "win32", microphoneStatus: () => "unknown" })).toBe("grant");
  });

  it("keeps granting video-only capture such as preview tab recording", () => {
    expect(decide({ mediaTypes: ["video"], microphoneStatus: () => "denied" })).toBe("grant");
  });
});
