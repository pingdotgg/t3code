/**
 * Android windowing policy for orientation. The Kotlin in
 * `plugins/withAndroidTabletOrientation.cjs` must stay in lockstep with this
 * function: phones stay portrait-locked, everything else that is a real
 * window (tablet/fold inner screen, DeX, Pixel Desktop, ChromeOS) unlocks.
 *
 * `uiModeType` is `Configuration.uiMode & UI_MODE_TYPE_MASK`.
 */
export const ANDROID_TABLET_SMALLEST_WIDTH_DP = 600;

/** `android.content.res.Configuration.UI_MODE_TYPE_NORMAL` */
export const ANDROID_UI_MODE_TYPE_NORMAL = 1;
/** `android.content.res.Configuration.UI_MODE_TYPE_DESK` — DeX, Pixel Desktop, ChromeOS. */
export const ANDROID_UI_MODE_TYPE_DESK = 2;
/** `android.content.res.Configuration.UI_MODE_TYPE_CAR` */
export const ANDROID_UI_MODE_TYPE_CAR = 3;

export function shouldUnlockAndroidScreenOrientation(input: {
  readonly smallestScreenWidthDp: number;
  readonly uiModeType: number;
}): boolean {
  if (input.smallestScreenWidthDp >= ANDROID_TABLET_SMALLEST_WIDTH_DP) {
    return true;
  }
  return input.uiModeType === ANDROID_UI_MODE_TYPE_DESK;
}
