import { describe, expect, it } from "vitest";
import { JS_BACK_HANDLER_NATIVE_ID } from "../src/lib/androidNativeBack";
import withAndroidNativeScreenBack from "./withAndroidNativeScreenBack.cjs";
import withAndroidPredictiveBackCompat from "./withAndroidPredictiveBackCompat.cjs";

const mainActivity = `package com.t3tools.t3code
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun invokeDefaultOnBackPressed() {
      super.invokeDefaultOnBackPressed()
  }
}`;

async function transform(plugin, contents, extraConfig = {}) {
  const config = plugin({ name: "Test", slug: "test", ...extraConfig });
  const result = await config.mods.android.mainActivity({
    ...config,
    modRequest: { platform: "android", modName: "mainActivity", introspect: false },
    modResults: { language: "kt", contents },
  });
  return result.modResults.contents;
}

describe("Android native screen back generation", () => {
  it("registers the callback after onCreate and dismisses opted-in screens natively", async () => {
    const result = await transform(withAndroidNativeScreenBack, mainActivity);
    expect(result).toContain("import androidx.activity.OnBackPressedCallback");
    expect(result).toContain("import com.swmansion.rnscreens.ScreenStack");
    expect(result).toContain("override fun onPostCreate(savedInstanceState: Bundle?) {");
    expect(result).toContain("onBackPressedDispatcher.addCallback(this, nativeScreenBackCallback)");
    expect(result).toContain("target.dismissFromContainer()");
    expect(result).toContain("top.nativeBackButtonDismissalEnabled");
  });

  it("leaves back to JS while in-window UI marked for JS back is on screen", async () => {
    const result = await transform(withAndroidNativeScreenBack, mainActivity);
    expect(result).toContain("import com.facebook.react.uimanager.util.ReactFindViewUtil");
    expect(result).toContain(
      "if (ReactFindViewUtil.findView(window.decorView, JS_BACK_HANDLER_NATIVE_ID) != null) return null",
    );
    expect(result).toContain(
      `const val JS_BACK_HANDLER_NATIVE_ID = "${JS_BACK_HANDLER_NATIVE_ID}"`,
    );
  });

  it("turns the callback off while the default back action runs", async () => {
    const result = await transform(withAndroidNativeScreenBack, mainActivity);
    const wrapper = result.slice(result.indexOf("override fun invokeDefaultOnBackPressed() {"));
    expect(wrapper.indexOf("nativeScreenBackCallback.isEnabled = false")).toBeLessThan(
      wrapper.indexOf("invokeDefaultOnBackPressedAfterNativeScreenBack()"),
    );
    expect(result).toContain(
      "private fun invokeDefaultOnBackPressedAfterNativeScreenBack() {\n      super.invokeDefaultOnBackPressed()",
    );
  });

  it("wraps the predictive back compat wrapper instead of replacing it", async () => {
    const compat = await transform(withAndroidPredictiveBackCompat, mainActivity, {
      android: { predictiveBackGestureEnabled: true },
    });
    const result = await transform(withAndroidNativeScreenBack, compat);
    expect(result.match(/import androidx\.activity\.OnBackPressedCallback/g)).toHaveLength(1);
    expect(result).toContain("predictiveBackCompatCallback.isEnabled = false");
    expect(result).toContain("nativeScreenBackCallback.isEnabled = false");
    expect(result).toContain("private fun invokeDefaultOnBackPressedLegacy() {");
  });

  it("does not duplicate code on subsequent prebuilds", async () => {
    const generated = await transform(withAndroidNativeScreenBack, mainActivity);
    expect(await transform(withAndroidNativeScreenBack, generated)).toBe(generated);
  });

  it("fails visibly when the Expo MainActivity template changes", async () => {
    await expect(
      transform(withAndroidNativeScreenBack, "import android.os.Bundle\nclass MainActivity {}"),
    ).rejects.toThrow("could not find the MainActivity class declaration");
  });
});
