import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} }, nativeBuildVersion: "1" },
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "android" },
}));

import {
  parsePersonalPreviewRelease,
  parsePersonalPreviewUpdateConfig,
  selectNewerPersonalPreviewUpdate,
} from "./personal-preview-updates";

const release = {
  draft: false,
  tag_name: "mark-mobile-preview-v1785653285",
  name: "T3 Code Preview 2026-08-02",
  assets: [
    {
      name: "t3-code-preview.apk",
      browser_download_url:
        "https://github.com/Feighery89/t3code/releases/download/mark-mobile-preview-v1785653285/t3-code-preview.apk",
    },
  ],
};

describe("personal preview update parsing", () => {
  it("accepts only the fork's exact latest-release endpoint", () => {
    expect(
      parsePersonalPreviewUpdateConfig({
        latestReleaseApiUrl: "https://api.github.com/repos/Feighery89/t3code/releases/latest",
      }),
    ).toEqual({
      latestReleaseApiUrl: "https://api.github.com/repos/Feighery89/t3code/releases/latest",
    });
    expect(
      parsePersonalPreviewUpdateConfig({
        latestReleaseApiUrl: "https://example.test/repos/Feighery89/t3code/releases/latest",
      }),
    ).toBeNull();
    expect(
      parsePersonalPreviewUpdateConfig({
        latestReleaseApiUrl: "https://api.github.com/repos/someone-else/t3code/releases/latest",
      }),
    ).toBeNull();
  });

  it("extracts the version and trusted APK asset", () => {
    expect(parsePersonalPreviewRelease(release)).toEqual({
      versionCode: 1785653285,
      versionName: "T3 Code Preview 2026-08-02",
      downloadUrl:
        "https://github.com/Feighery89/t3code/releases/download/mark-mobile-preview-v1785653285/t3-code-preview.apk",
    });
  });

  it("rejects a release whose APK points outside the fork", () => {
    expect(() =>
      parsePersonalPreviewRelease({
        ...release,
        assets: [
          {
            name: "t3-code-preview.apk",
            browser_download_url:
              "https://example.test/mark-mobile-preview-v1785653285/t3-code-preview.apk",
          },
        ],
      }),
    ).toThrow("download URL was invalid");
  });

  it("returns only releases newer than the installed build", () => {
    const parsed = parsePersonalPreviewRelease(release);
    expect(selectNewerPersonalPreviewUpdate("1785653284", parsed)).toEqual(parsed);
    expect(selectNewerPersonalPreviewUpdate("1785653285", parsed)).toBeNull();
    expect(selectNewerPersonalPreviewUpdate("1785653286", parsed)).toBeNull();
  });

  it("rejects malformed installed and release versions", () => {
    expect(() =>
      selectNewerPersonalPreviewUpdate("1.0.1", parsePersonalPreviewRelease(release)),
    ).toThrow("installed preview version was invalid");
    expect(() =>
      parsePersonalPreviewRelease({ ...release, tag_name: "mark-mobile-preview-v1.2.3" }),
    ).toThrow("release version was invalid");
  });
});
