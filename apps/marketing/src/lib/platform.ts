import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from "./site";

export type Platform = {
  os: "mac" | "win" | "linux" | "ios" | "android";
  label: string;
};

const IOS: Platform = { os: "ios", label: "Download for iOS" };

export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform | null {
  // Mobile checks come first: Android user agents contain "Linux" and iOS
  // user agents contain "Mac OS X".
  if (/Android/i.test(userAgent)) return { os: "android", label: "Download for Android" };
  if (/iPhone|iPad|iPod/i.test(userAgent)) return IOS;
  if (/Win/i.test(userAgent)) return { os: "win", label: "Download for Windows" };
  // iPadOS Safari sends a Mac user agent by default; only the touch screen
  // tells it apart from a Mac.
  if (/Mac/i.test(userAgent)) {
    return maxTouchPoints > 1 ? IOS : { os: "mac", label: "Download for macOS" };
  }
  if (/Linux/i.test(userAgent)) return { os: "linux", label: "Download for Linux" };
  return null;
}

export function getMobileStoreUrl(platform: Platform): string | null {
  if (platform.os === "ios") return IOS_APP_STORE_URL;
  if (platform.os === "android") return ANDROID_PLAY_STORE_URL;
  return null;
}
