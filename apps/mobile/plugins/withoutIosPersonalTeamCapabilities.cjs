const { withEntitlementsPlist } = require("expo/config-plugins");

// Register this plugin EARLY in app.config plugins so its entitlements mod runs
// LAST (same-type mods are last-registered-first). That lets it strip
// capabilities other plugins re-add (expo-notifications, associated domains).
module.exports = function withoutIosPersonalTeamCapabilities(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    delete modConfig.modResults["com.apple.developer.applesignin"];
    delete modConfig.modResults["com.apple.developer.associated-domains"];
    delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
