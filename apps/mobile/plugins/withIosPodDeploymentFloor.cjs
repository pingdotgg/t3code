const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# t3code: raise pod deployment targets to the Xcode-supported floor";
const FLOOR_BUMP = `${MARKER}
    # Xcode 27 refuses to build targets with IPHONEOS_DEPLOYMENT_TARGET below
    # 15.0, and several transitive pods (SDWebImage, GoogleUtilities, AppAuth,
    # RNSVG, ReachabilitySwift) still declare 9.0-12.4. Raising the floor is a
    # no-op for the app itself (deployment target 18.0).
    installer.pods_project.targets.each do |floor_target|
      floor_target.build_configurations.each do |floor_config|
        floor_value = floor_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if floor_value && floor_value.to_f < 15.0
          floor_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
        end
      end
    end
`;

module.exports = function withIosPodDeploymentFloor(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes(MARKER)) {
        return nextConfig;
      }

      const postInstallStart = "post_install do |installer|\n";
      if (!podfile.includes(postInstallStart)) {
        throw new Error("Unable to raise pod deployment floor: post_install is missing.");
      }

      fs.writeFileSync(
        podfilePath,
        podfile.replace(postInstallStart, `${postInstallStart}${FLOOR_BUMP}`),
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
