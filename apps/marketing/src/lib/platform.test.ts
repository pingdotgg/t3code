import { expect, it } from "vite-plus/test";

import { detectPlatform, getMobileStoreUrl } from "./platform";
import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from "./site";

it.each([
  {
    name: "Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    url: ANDROID_PLAY_STORE_URL,
    label: "Download for Android",
    os: "android",
  },
  {
    name: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    url: IOS_APP_STORE_URL,
    label: "Download for iOS",
    os: "ios",
  },
  {
    name: "iPad with desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints: 5,
    url: IOS_APP_STORE_URL,
    label: "Download for iOS",
    os: "ios",
  },
  {
    name: "iPad with mobile user agent",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    url: IOS_APP_STORE_URL,
    label: "Download for iOS",
    os: "ios",
  },
  ...[0, 1].map((maxTouchPoints) => ({
    name: `macOS with ${maxTouchPoints} touch points`,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints,
    url: null,
    label: "Download for macOS",
    os: "mac",
  })),
  {
    name: "Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    url: null,
    label: "Download for Windows",
    os: "win",
  },
  {
    name: "Linux",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    url: null,
    label: "Download for Linux",
    os: "linux",
  },
])(
  "detects $name and selects its mobile store",
  ({ userAgent, maxTouchPoints, os, label, url }) => {
    const platform = detectPlatform(userAgent, maxTouchPoints);
    expect(platform).toEqual({ os, label });
    expect(getMobileStoreUrl(platform!)).toBe(url);
  },
);

it("leaves unknown platforms undetected", () => {
  expect(detectPlatform("unknown", 0)).toBeNull();
});
