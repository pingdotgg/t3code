import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import {
  ANDROID_TABLET_SMALLEST_WIDTH_DP,
  ANDROID_UI_MODE_TYPE_CAR,
  ANDROID_UI_MODE_TYPE_DESK,
  ANDROID_UI_MODE_TYPE_NORMAL,
  shouldUnlockAndroidScreenOrientation,
} from "./androidWindowing";

const require = NodeModule.createRequire(import.meta.url);
const { patchMainActivity } = require("../../plugins/withAndroidTabletOrientation.cjs") as {
  patchMainActivity: (contents: string) => string;
};

const EXPO_MAIN_ACTIVITY = `package com.t3tools.t3code
import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`;

const LEGACY_MAIN_ACTIVITY = `package com.t3tools.t3code
import android.os.Bundle
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  // Applied in onCreate and re-applied on fold/unfold; added by
  // withAndroidTabletOrientation.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyTabletOrientation()
  }

  private fun applyTabletOrientation() {
    requestedOrientation = if (resources.configuration.smallestScreenWidthDp >= 600) {
      ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    } else {
      ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    applyTabletOrientation()
  }
}
`;

describe("shouldUnlockAndroidScreenOrientation", () => {
  it("keeps phones in the portrait manifest lock", () => {
    expect(
      shouldUnlockAndroidScreenOrientation({
        smallestScreenWidthDp: 411,
        uiModeType: ANDROID_UI_MODE_TYPE_NORMAL,
      }),
    ).toBe(false);
  });

  it("unlocks foldables and tablets at the 600dp smallest-width breakpoint", () => {
    expect(
      shouldUnlockAndroidScreenOrientation({
        smallestScreenWidthDp: ANDROID_TABLET_SMALLEST_WIDTH_DP,
        uiModeType: ANDROID_UI_MODE_TYPE_NORMAL,
      }),
    ).toBe(true);
    expect(
      shouldUnlockAndroidScreenOrientation({
        smallestScreenWidthDp: ANDROID_TABLET_SMALLEST_WIDTH_DP - 1,
        uiModeType: ANDROID_UI_MODE_TYPE_NORMAL,
      }),
    ).toBe(false);
  });

  it("unlocks desktop windows (DeX, Pixel Desktop, ChromeOS) even when smallest width is phone-sized", () => {
    expect(
      shouldUnlockAndroidScreenOrientation({
        smallestScreenWidthDp: 411,
        uiModeType: ANDROID_UI_MODE_TYPE_DESK,
      }),
    ).toBe(true);
  });

  it("does not treat other UI modes as desktop", () => {
    expect(
      shouldUnlockAndroidScreenOrientation({
        smallestScreenWidthDp: 411,
        uiModeType: ANDROID_UI_MODE_TYPE_CAR,
      }),
    ).toBe(false);
  });
});

describe("withAndroidTabletOrientation MainActivity patch", () => {
  it("unlocks desk-mode windows and rebinds display metrics from the activity", () => {
    const patched = patchMainActivity(EXPO_MAIN_ACTIVITY);
    expect(patched).toContain("UI_MODE_TYPE_DESK");
    expect(patched).toContain(`smallestScreenWidthDp >= ${ANDROID_TABLET_SMALLEST_WIDTH_DP}`);
    expect(patched).toContain("DisplayMetricsHolder.initDisplayMetrics(this)");
    expect(patched).toContain("applyWindowedOrientation()");
    expect(patched).toContain("rebindWindowDisplayMetrics()");
  });

  it("emits the complete phone/tablet/desk policy and configuration rebind path", () => {
    const patched = patchMainActivity(EXPO_MAIN_ACTIVITY);
    expect(patched).toContain(`val uiModeType = config.uiMode and Configuration.UI_MODE_TYPE_MASK`);
    expect(patched).toContain(
      `val unlockOrientation =\n      config.smallestScreenWidthDp >= ${ANDROID_TABLET_SMALLEST_WIDTH_DP} || uiModeType == Configuration.UI_MODE_TYPE_DESK`,
    );
    expect(patched).toContain(
      `if (unlockOrientation) {\n        ActivityInfo.SCREEN_ORIENTATION_FULL_USER\n      } else {\n        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT`,
    );
    expect(patched).toContain(
      "DisplayMetricsHolder.initDisplayMetrics(this)\n    window.decorView.post { window.decorView.requestLayout() }",
    );
    expect(patched).toContain(
      "super.onConfigurationChanged(newConfig)\n    applyWindowedOrientation()\n    rebindWindowDisplayMetrics()",
    );
  });

  it("replaces the tablet-only injection on existing MainActivity files", () => {
    const patched = patchMainActivity(LEGACY_MAIN_ACTIVITY);
    expect(patched).not.toContain("applyTabletOrientation");
    expect(patched).toContain("UI_MODE_TYPE_DESK");
    expect(patched).toContain("DisplayMetricsHolder.initDisplayMetrics(this)");
    expect(patched).toContain("applyWindowedOrientation()\n    rebindWindowDisplayMetrics()");
  });

  it("is idempotent", () => {
    const once = patchMainActivity(EXPO_MAIN_ACTIVITY);
    expect(patchMainActivity(once)).toBe(once);
  });
});
