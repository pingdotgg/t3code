const { withMainActivity } = require("expo/config-plugins");

// The top-level `orientation: "portrait"` writes android:screenOrientation="portrait"
// into the manifest, which locks every Android device — including tablets — to
// portrait. iOS doesn't have this problem: iPads must support all orientations
// because the app is multitasking-capable, so only iPhones end up portrait-only.
// Mirror that split on Android: keep the manifest lock for phones and lift it at
// runtime when the window is a tablet/fold (smallest width >= 600dp) OR a desktop
// shell (UI_MODE_TYPE_DESK: Samsung DeX, Pixel Desktop, ChromeOS).
// requestedOrientation set at runtime overrides the manifest value. FULL_USER
// allows all four orientations while still respecting the user's auto-rotate
// lock, matching iPad behavior.
//
// Foldables change smallestScreenWidthDp on fold/unfold without recreating the
// activity (smallestScreenSize is in the manifest's configChanges), and desktop
// windowing changes density the same way. Re-evaluate in onConfigurationChanged.
//
// Keep the unlock predicate in lockstep with
// apps/mobile/src/lib/androidWindowing.ts.

const WINDOWING_IMPORTS = `
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import com.facebook.react.uimanager.DisplayMetricsHolder`;

const WINDOWING_METHODS = `
  // Applied in onCreate and re-applied on fold/unfold and desktop-window
  // attach; added by withAndroidTabletOrientation.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyWindowedOrientation()
    rebindWindowDisplayMetrics()
  }

  private fun applyWindowedOrientation() {
    val config = resources.configuration
    val uiModeType = config.uiMode and Configuration.UI_MODE_TYPE_MASK
    val unlockOrientation =
      config.smallestScreenWidthDp >= 600 || uiModeType == Configuration.UI_MODE_TYPE_DESK
    requestedOrientation =
      if (unlockOrientation) {
        ActivityInfo.SCREEN_ORIENTATION_FULL_USER
      } else {
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
      }
  }

  // RN's host re-inits DisplayMetricsHolder from the React/application
  // context, which keeps the phone's density inside a desktop window. Super
  // already ran that path; re-bind from this activity so Yoga and text paint
  // use the window metrics, then relayout.
  private fun rebindWindowDisplayMetrics() {
    DisplayMetricsHolder.initDisplayMetrics(this)
    window.decorView.post { window.decorView.requestLayout() }
  }
`;

const WINDOWING_ON_CREATE_CALL = `
    applyWindowedOrientation()
    rebindWindowDisplayMetrics()`;

const LEGACY_ORIENTATION_METHODS = `
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
`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidTabletOrientation: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

function patchMainActivity(contents) {
  if (contents.includes("rebindWindowDisplayMetrics")) {
    return contents;
  }

  if (contents.includes("applyTabletOrientation")) {
    if (!contents.includes(LEGACY_ORIENTATION_METHODS.trim())) {
      throw new Error(
        "withAndroidTabletOrientation: found applyTabletOrientation but could not replace the legacy injection; update the plugin anchors.",
      );
    }
    contents = contents.replace(LEGACY_ORIENTATION_METHODS, WINDOWING_METHODS);
    contents = contents.replace("\n    applyTabletOrientation()", WINDOWING_ON_CREATE_CALL);
    if (!contents.includes("import com.facebook.react.uimanager.DisplayMetricsHolder")) {
      contents = insertAfter(
        contents,
        "import android.content.res.Configuration",
        "\nimport com.facebook.react.uimanager.DisplayMetricsHolder",
        "the Configuration import from the legacy injection",
      );
    }
    return contents;
  }

  contents = insertAfter(
    contents,
    "import android.os.Bundle",
    WINDOWING_IMPORTS,
    "the android.os.Bundle import",
  );
  contents = insertAfter(
    contents,
    "class MainActivity : ReactActivity() {",
    WINDOWING_METHODS,
    "the MainActivity class declaration",
  );
  contents = insertAfter(
    contents,
    "super.onCreate(null)",
    WINDOWING_ON_CREATE_CALL,
    "the super.onCreate call",
  );
  return contents;
}

function withAndroidTabletOrientation(config) {
  return withMainActivity(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidTabletOrientation: MainActivity must be Kotlin.");
    }
    nextConfig.modResults.contents = patchMainActivity(nextConfig.modResults.contents);
    return nextConfig;
  });
}

withAndroidTabletOrientation.patchMainActivity = patchMainActivity;

module.exports = withAndroidTabletOrientation;
