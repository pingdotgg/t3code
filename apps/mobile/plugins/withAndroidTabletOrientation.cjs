const { withMainActivity } = require("expo/config-plugins");

// FULL_USER respects rotation lock. Foldables change smallestScreenWidthDp without recreating the activity.

const ORIENTATION_METHODS = `
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

const ORIENTATION_ON_CREATE_CALL = `
    applyTabletOrientation()`;

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

module.exports = function withAndroidTabletOrientation(config) {
  return withMainActivity(config, (nextConfig) => {
    let contents = nextConfig.modResults.contents;
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("withAndroidTabletOrientation: MainActivity must be Kotlin.");
    }
    if (contents.includes("SCREEN_ORIENTATION_FULL_USER")) {
      return nextConfig;
    }

    contents = insertAfter(
      contents,
      "import android.os.Bundle",
      "\nimport android.content.pm.ActivityInfo\nimport android.content.res.Configuration",
      "the android.os.Bundle import",
    );
    contents = insertAfter(
      contents,
      "class MainActivity : ReactActivity() {",
      ORIENTATION_METHODS,
      "the MainActivity class declaration",
    );
    contents = insertAfter(
      contents,
      "super.onCreate(null)",
      ORIENTATION_ON_CREATE_CALL,
      "the super.onCreate call",
    );

    nextConfig.modResults.contents = contents;
    return nextConfig;
  });
};
