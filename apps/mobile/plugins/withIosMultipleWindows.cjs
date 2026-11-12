const { withInfoPlist } = require("expo/config-plugins");

// UIKit opens a second window (iPad, iPhone Duo) only for apps that declare support. Expo's
// template writes the scene manifest with it off; the rest of the manifest stays as generated.
module.exports = function withIosMultipleWindows(config) {
  return withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.UIApplicationSceneManifest = {
      ...nextConfig.modResults.UIApplicationSceneManifest,
      UIApplicationSupportsMultipleScenes: true,
    };
    return nextConfig;
  });
};
