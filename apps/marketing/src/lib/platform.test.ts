import { expect, it } from "vite-plus/test";

import { detectPlatform } from "./platform";

it.each([
  {
    // Android user agents also contain "Linux".
    name: "Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    os: "android",
  },
  {
    name: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    os: "ios",
  },
  {
    // iPad Safari sends a desktop Mac user agent by default.
    name: "iPad with a desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints: 5,
    os: "ios",
  },
  {
    name: "macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15",
    maxTouchPoints: 0,
    os: "mac",
  },
])("$name visitors get the $os download", ({ userAgent, maxTouchPoints, os }) => {
  const platform = detectPlatform(userAgent, maxTouchPoints);
  expect(platform?.os).toBe(os);
});
