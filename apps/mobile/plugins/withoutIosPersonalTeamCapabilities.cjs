const { withEntitlementsPlist } = require("expo/config-plugins");

// Runs after Expo's own entitlement mods but before earlier plugins' mods; app.config.ts
// gates those plugins (expo-notifications, Clerk) instead.
module.exports = function withoutIosPersonalTeamCapabilities(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["com.apple.developer.associated-domains"];
    delete modConfig.modResults["com.apple.developer.applesignin"];
    delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
