const { withAndroidStyles } = require("expo/config-plugins");

module.exports = function withAndroidInputBackground(config) {
  return withAndroidStyles(config, (config) => {
    const appTheme = config.modResults.resources.style?.find(
      (style) => style.$?.name === "AppTheme",
    );
    if (!appTheme) {
      throw new Error("withAndroidInputBackground: AppTheme is missing from styles.xml.");
    }

    // Inputs draw their own backgrounds and borders. Remove the native underline
    // drawable so it cannot peek out beneath rounded corners or return on focus.
    // Set both attributes for AppCompat and framework EditText implementations.
    appTheme.item ??= [];
    for (const name of ["editTextBackground", "android:editTextBackground"]) {
      const existing = appTheme.item.find((item) => item.$?.name === name);
      if (existing) {
        existing._ = "@null";
      } else {
        appTheme.item.push({ $: { name }, _: "@null" });
      }
    }

    return config;
  });
};
