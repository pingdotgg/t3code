const { AndroidConfig, withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const MICROPHONE_USAGE_DESCRIPTION =
  "Allow T3 Code to use your microphone for voice conversations with your coding agents.";

const REQUIRED_ANDROID_PERMISSIONS = [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.INTERNET",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.RECORD_AUDIO",
];

const MEDIA_PROJECTION_SERVICE = "com.oney.WebRTCModule.MediaProjectionService";
const MEDIA_PROJECTION_SERVICE_NAMES = new Set([
  MEDIA_PROJECTION_SERVICE,
  ".MediaProjectionService",
]);

function setRequiredAndroidPermissions(androidManifest) {
  const permissions = androidManifest.manifest["uses-permission"] ?? [];
  const requiredPermissions = new Set(REQUIRED_ANDROID_PERMISSIONS);

  androidManifest.manifest["uses-permission"] = permissions
    .filter((permission) => !requiredPermissions.has(permission.$?.["android:name"]))
    .concat(
      REQUIRED_ANDROID_PERMISSIONS.map((permission) => ({
        $: { "android:name": permission },
      })),
    );
}

function removeMediaProjectionService(androidManifest) {
  AndroidConfig.Manifest.ensureToolsAvailable(androidManifest);

  const application = androidManifest.manifest.application?.[0];
  if (application == null) {
    throw new Error(
      "withVoiceSupervisorNativeConfig: AndroidManifest.xml is missing the application element.",
    );
  }

  const services = application.service ?? [];
  application.service = services
    .filter((service) => !MEDIA_PROJECTION_SERVICE_NAMES.has(service.$?.["android:name"]))
    .concat({
      $: {
        "android:name": MEDIA_PROJECTION_SERVICE,
        "tools:node": "remove",
      },
    });
}

function withVoiceSupervisorNativeConfig(config) {
  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.NSMicrophoneUsageDescription = MICROPHONE_USAGE_DESCRIPTION;
    return nextConfig;
  });

  return withAndroidManifest(config, (nextConfig) => {
    setRequiredAndroidPermissions(nextConfig.modResults);
    removeMediaProjectionService(nextConfig.modResults);
    return nextConfig;
  });
}

module.exports = withVoiceSupervisorNativeConfig;
module.exports.MEDIA_PROJECTION_SERVICE = MEDIA_PROJECTION_SERVICE;
module.exports.MICROPHONE_USAGE_DESCRIPTION = MICROPHONE_USAGE_DESCRIPTION;
module.exports.REQUIRED_ANDROID_PERMISSIONS = REQUIRED_ANDROID_PERMISSIONS;
module.exports.removeMediaProjectionService = removeMediaProjectionService;
module.exports.setRequiredAndroidPermissions = setRequiredAndroidPermissions;
