const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

// Environments behind a private CA installed in the user store must work like they do in Chrome.
// Android ignores usesCleartextTraffic once a network security config exists, so permit it here.
const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

function withNetworkSecurityConfigManifest(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for network security configuration.",
      );
    }

    application.$ ??= {};
    application.$["android:networkSecurityConfig"] = "@xml/network_security_config";

    return nextConfig;
  });
}

function withNetworkSecurityConfigResource(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, "network_security_config.xml"), NETWORK_SECURITY_CONFIG);
      return config;
    },
  ]);
}

module.exports = function withAndroidNetworkSecurityConfig(config) {
  return withNetworkSecurityConfigResource(withNetworkSecurityConfigManifest(config));
};
