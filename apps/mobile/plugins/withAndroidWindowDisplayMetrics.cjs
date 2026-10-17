const { withMainActivity } = require("expo/config-plugins");

// React Native converts dp/sp to pixels (PixelUtil, text measurement) with the
// density in DisplayMetricsHolder, which it fills from the application context:
// `defaultDisplay.getRealMetrics()` there is always the built-in screen. When the
// activity runs on an external display (Pixel Desktop, Samsung DeX), Fabric
// lays the surface out with the window's density but measures text with the
// phone's, so text gets line boxes sized for a different density and is clipped
// and overlapped. Re-point the holder at the activity's own display after React
// Native fills it. The root view's constructor re-reads it from the application
// context, and Expo's delegate builds that view after onCreate returns, so bind
// when the view is handed to setContentView (before the first JS commit can
// measure text), and again after every configuration change, where ReactHost
// re-reads it too. On the built-in screen the two are the same metrics, so this
// is a no-op there.

const BIND_METHOD = `
  // Keeps React Native on this window's display density; added by
  // withAndroidWindowDisplayMetrics.
  @Suppress("DEPRECATION")
  private fun bindWindowDisplayMetrics() {
    val windowMetrics = resources.displayMetrics
    val metrics = DisplayMetrics()
    metrics.setTo(windowMetrics)
    windowManager.defaultDisplay.getRealMetrics(metrics)
    metrics.scaledDensity = windowMetrics.scaledDensity
    DisplayMetricsHolder.setScreenDisplayMetrics(metrics)
  }
`;

const CONFIGURATION_CHANGED_METHOD = `
  // Re-binds after ReactHost re-reads display metrics; added by
  // withAndroidWindowDisplayMetrics.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    bindWindowDisplayMetrics()
  }
`;

const SET_CONTENT_VIEW_METHOD = `
  // React Native's root view re-reads display metrics when it is constructed,
  // just before it is set as the content view; added by
  // withAndroidWindowDisplayMetrics.
  override fun setContentView(view: View?) {
    super.setContentView(view)
    bindWindowDisplayMetrics()
  }
`;

const CONFIGURATION_CHANGED_SIGNATURE =
  "override fun onConfigurationChanged(newConfig: Configuration) {";

const BIND_CALL = `
    bindWindowDisplayMetrics()`;

function insertAfter(contents, anchor, insertion, description) {
  const index = contents.indexOf(anchor);
  if (index === -1) {
    throw new Error(
      `withAndroidWindowDisplayMetrics: could not find ${description} in MainActivity — the Expo template changed; update the plugin anchors.`,
    );
  }
  const end = index + anchor.length;
  return contents.slice(0, end) + insertion + contents.slice(end);
}

function addImport(contents, importLine) {
  if (contents.includes(importLine)) {
    return contents;
  }
  return insertAfter(
    contents,
    "import android.os.Bundle",
    `\n${importLine}`,
    "the android.os.Bundle import",
  );
}

module.exports = function withAndroidWindowDisplayMetrics(config) {
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidWindowDisplayMetrics: MainActivity must be Kotlin.");
    }
    if (contents.includes("bindWindowDisplayMetrics")) {
      return nextConfig;
    }

    contents = addImport(contents, "import android.util.DisplayMetrics");
    contents = addImport(contents, "import android.view.View");
    contents = addImport(contents, "import com.facebook.react.uimanager.DisplayMetricsHolder");
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      BIND_METHOD + SET_CONTENT_VIEW_METHOD,
      "the MainActivity class declaration",
    );
    // Another plugin (withAndroidTabletOrientation) may already override
    // onConfigurationChanged; extend it rather than declaring a second override.
    const overrideStart = contents.indexOf(CONFIGURATION_CHANGED_SIGNATURE);
    if (overrideStart !== -1) {
      contents =
        contents.slice(0, overrideStart) +
        insertAfter(
          contents.slice(overrideStart),
          "super.onConfigurationChanged(newConfig)",
          BIND_CALL,
          "the super call in the onConfigurationChanged override",
        );
    } else {
      contents = addImport(contents, "import android.content.res.Configuration");
      contents = insertAfter(
        contents,
        "class MainActivity : ReactActivity() {",
        CONFIGURATION_CHANGED_METHOD,
        "the MainActivity class declaration",
      );
    }

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
