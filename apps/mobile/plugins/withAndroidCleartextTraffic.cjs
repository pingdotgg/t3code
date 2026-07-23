const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for cleartext traffic configuration.",
      );
    }

    application.$ ??= {};
    application.$["android:usesCleartextTraffic"] = "true";

    return nextConfig;
  });
};
