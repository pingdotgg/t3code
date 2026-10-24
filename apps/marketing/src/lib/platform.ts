import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from "./site";

export type Platform = { os: "android" | "ios" | "mac" | "win" | "linux"; label: string };

export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform | null {
  // Android user agents contain "Linux" and iOS ones contain "Mac OS X", so the
  // mobile checks run before the desktop ones. iPad Safari sends a desktop Mac
  // user agent by default; the touch points tell it apart from a Mac.
  if (/Android/i.test(userAgent)) return { os: "android", label: "Download for Android" };
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) {
    return { os: "ios", label: "Download for iOS" };
  }
  if (/Win/i.test(userAgent)) return { os: "win", label: "Download for Windows" };
  if (/Mac/i.test(userAgent)) return { os: "mac", label: "Download for macOS" };
  if (/Linux/i.test(userAgent)) return { os: "linux", label: "Download for Linux" };
  return null;
}

export function getMobileStoreUrl(platform: Platform): string | null {
  if (platform.os === "android") return ANDROID_PLAY_STORE_URL;
  if (platform.os === "ios") return IOS_APP_STORE_URL;
  return null;
}
