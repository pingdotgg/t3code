import { describe, expect, it, vi } from "vite-plus/test";

import { readDeviceLocales } from "./deviceLocales";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  TurboModuleRegistry: {
    get: () => ({ getNativeLocales: () => ["en_GB@calendar=gregorian", "en-US"] }),
  },
}));

describe("readDeviceLocales", () => {
  it("reads the iOS region setting as a language tag", () => {
    expect(readDeviceLocales()).toEqual({ regionalLocale: "en-GB", preferredLanguages: ["en-US"] });
  });
});
