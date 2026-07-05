const { withEntitlementsPlist } = require("expo/config-plugins");

// Entitlements a free Apple ID (Personal Team) cannot sign. Other plugins
// (Clerk, notifications) add these earlier in the chain; this plugin runs
// last and strips them so `SERGECODE_PERSONAL_SIGNING=1` device builds
// provision cleanly. Sign-in-with-Apple and push are unavailable in such
// builds by definition — everything else works.
const PERSONAL_TEAM_UNSUPPORTED = [
  "aps-environment",
  "com.apple.developer.applesignin",
  "com.apple.developer.associated-domains",
  "com.apple.security.application-groups",
];

module.exports = function withPersonalTeamEntitlements(config) {
  return withEntitlementsPlist(config, (nextConfig) => {
    for (const key of PERSONAL_TEAM_UNSUPPORTED) {
      delete nextConfig.modResults[key];
    }
    return nextConfig;
  });
};
