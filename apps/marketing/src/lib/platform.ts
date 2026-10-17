import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from "./site";

export type Platform = { os: "android" | "ios" | "mac" | "win" | "linux"; label: string };

export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform | null {
  const ua = userAgent;
  if (/Android/i.test(ua)) return { os: "android", label: "Download for Android" };
  // iPad Safari uses a desktop Mac user agent by default.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) {
    return { os: "ios", label: "Download for iOS" };
  }
  if (/Win/i.test(ua)) return { os: "win", label: "Download for Windows" };
  if (/Mac/i.test(ua)) return { os: "mac", label: "Download for macOS" };
  if (/Linux/i.test(ua)) return { os: "linux", label: "Download for Linux" };
  return null;
}

export function getMobileStoreUrl(platform: Platform): string | null {
  if (platform.os === "android") return ANDROID_PLAY_STORE_URL;
  if (platform.os === "ios") return IOS_APP_STORE_URL;
  return null;
}
