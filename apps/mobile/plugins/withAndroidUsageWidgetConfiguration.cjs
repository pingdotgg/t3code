const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod, withMainActivity } = require("expo/config-plugins");

const ACTIVITY = "expo.modules.t3widgetexpiry.WidgetConfigurationActivity";

module.exports = function withAndroidUsageWidgetConfiguration(config) {
  config = withMainActivity(config, (next) => {
    let contents = next.modResults.contents;
    if (next.modResults.language !== "kt" || !contents.includes("  override fun onCreate")) {
      throw new Error("Android widget links require the Kotlin MainActivity template.");
    }
    if (!contents.includes("android.content.Intent")) {
      if (!contents.includes("import android.os.Bundle")) {
        throw new Error("Android widget links could not find MainActivity imports.");
      }
      contents = contents.replace(
        "import android.os.Bundle",
        "import android.os.Bundle\nimport android.content.Intent",
      );
    }
    if (!contents.includes("override fun onNewIntent")) {
      contents = contents.replace(
        "  override fun onCreate",
        `  // Preserve widget links delivered while Expo is recreating the task.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }

  override fun onCreate`,
      );
    } else if (!contents.includes("    setIntent(intent)")) {
      throw new Error("Android widget links require onNewIntent to preserve the activity intent.");
    }
    next.modResults.contents = contents;
    return next;
  });
  config = withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android widget configuration requires an application.");
    const scheme = Array.isArray(next.scheme) ? next.scheme[0] : next.scheme;
    if (!scheme) throw new Error("Android widget configuration requires an app scheme.");
    application.activity ??= [];
    application.activity = application.activity.filter(
      (activity) => activity.$["android:name"] !== ACTIVITY,
    );
    application.activity.push({
      $: {
        "android:name": ACTIVITY,
        "android:exported": "true",
        "android:theme": "@android:style/Theme.NoDisplay",
      },
      "meta-data": [
        {
          $: {
            "android:name": "t3code.widgetConfigurationUrl",
            "android:value": `${scheme}://settings/usage-widget`,
          },
        },
      ],
      "intent-filter": [
        { action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_CONFIGURE" } }] },
      ],
    });
    return next;
  });
  return withDangerousMod(config, [
    "android",
    (next) => {
      const file = path.join(
        next.modRequest.platformProjectRoot,
        "app/src/main/res/xml/subscription_usage_info.xml",
      );
      if (!fs.existsSync(file))
        throw new Error("expo-widgets did not generate SubscriptionUsage metadata.");
      const xml = fs
        .readFileSync(file, "utf8")
        .replace(/\s+android:configure="[^"]*"/g, "")
        .replace(/\s+android:widgetFeatures="[^"]*"/g, "")
        .replace(
          "<appwidget-provider",
          `<appwidget-provider android:configure="${ACTIVITY}" android:widgetFeatures="reconfigurable|configuration_optional"`,
        );
      fs.writeFileSync(file, xml);
      return next;
    },
  ]);
};
