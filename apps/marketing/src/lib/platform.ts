export type Platform = { os: "mac" | "win" | "linux" | "ios" | "android" };

export function detectPlatform(userAgent: string, maxTouchPoints: number): Platform | null {
  // Mobile checks come first: Android user agents contain "Linux" and iOS
  // user agents contain "Mac OS X".
  if (/Android/i.test(userAgent)) return { os: "android" };
  if (/iPhone|iPad|iPod/i.test(userAgent)) return { os: "ios" };
  if (/Win/i.test(userAgent)) return { os: "win" };
  // iPadOS Safari sends a Mac user agent by default; only the touch screen
  // tells it apart from a Mac.
  if (/Mac/i.test(userAgent)) return { os: maxTouchPoints > 1 ? "ios" : "mac" };
  if (/Linux/i.test(userAgent)) return { os: "linux" };
  return null;
}
