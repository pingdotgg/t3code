import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.0.0" } } }));
vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios", Version: "26.0" },
}));

import { buildMobileFeedbackIssueUrl } from "./feedback";

describe("buildMobileFeedbackIssueUrl", () => {
  it("includes the mobile app version and operating system", () => {
    const url = new URL(buildMobileFeedbackIssueUrl({ appVersion: "3.2.1", platform: "iOS 26.0" }));

    expect(url.searchParams.get("version")).toBe("3.2.1");
    expect(url.searchParams.get("environment")).toBe("T3 Code Mobile; iOS 26.0");
  });
});
