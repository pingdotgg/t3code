const { withMainActivity } = require("expo/config-plugins");

// React Native measures text with application-display density, which differs
// from the activity on external displays. Expo constructs its root after
// onCreate, resetting those metrics; ReactHost resets them on configuration
// changes too. Rebind after both, before text is measured.
const DISPLAY_METRICS_METHODS = `
  // Expo constructs the root view after onCreate; its constructor resets metrics.
  override fun setContentView(view: View?) {
    super.setContentView(view)
    DisplayMetricsHolder.initDisplayMetrics(this)
  }
`;

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
    if (contents.includes("DisplayMetricsHolder.initDisplayMetrics(this)")) {
      return nextConfig;
    }

    contents = addImport(contents, "import android.view.View");
    contents = addImport(contents, "import com.facebook.react.uimanager.DisplayMetricsHolder");
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      DISPLAY_METRICS_METHODS,
      "the MainActivity class declaration",
    );
    // Extend the tablet-orientation override, after ReactHost resets metrics.
    const overrideStart = contents.indexOf(
      "override fun onConfigurationChanged(newConfig: Configuration) {",
    );
    if (overrideStart !== -1) {
      contents =
        contents.slice(0, overrideStart) +
        insertAfter(
          contents.slice(overrideStart),
          "super.onConfigurationChanged(newConfig)",
          "\n    DisplayMetricsHolder.initDisplayMetrics(this)",
          "the super call in the onConfigurationChanged override",
        );
    } else {
      contents = addImport(contents, "import android.content.res.Configuration");
      contents = insertAfter(
        contents,
        "class MainActivity : ReactActivity() {",
        `
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    DisplayMetricsHolder.initDisplayMetrics(this)
  }
`,
        "the MainActivity class declaration",
      );
    }

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
