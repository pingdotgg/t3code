"use strict";

// expo-sharing intentionally uses a fixed target name and also uses that
// internal target name as CFBundleDisplayName. Brand the extension while
// leaving its initially-empty signing team intact: Expo uses that state to
// select ios.appleTeamId and enable first-time profile provisioning.
//
// ORDERING: list this plugin BEFORE expo-sharing. Expo runs same-type mods in
// reverse registration order, so this executes after the extension exists.

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET_NAME = "expo-sharing-extension";

function stripComments(section) {
  return Object.fromEntries(
    Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment")),
  );
}

function findByName(section, name) {
  return Object.entries(stripComments(section)).find(([, value]) => value?.name === name) ?? null;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function withDisplayNamePlist(config, displayName) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const plistPath = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, "Info.plist");
      if (!fs.existsSync(plistPath)) {
        throw new Error(
          `${TARGET_NAME}/Info.plist was not generated. Register withShareExtensionDisplayName before expo-sharing.`,
        );
      }
      const source = fs.readFileSync(plistPath, "utf8");
      const displayNamePattern = /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/;
      if (!displayNamePattern.test(source)) {
        throw new Error(`Could not update CFBundleDisplayName in ${plistPath}.`);
      }
      const next = source.replace(displayNamePattern, `$1${escapeXml(displayName)}$2`);
      if (next !== source) {
        fs.writeFileSync(plistPath, next);
      }
      return cfg;
    },
  ]);
}

function withExtensionDisplayNameBuildSetting(config, displayName) {
  return withXcodeProject(config, (cfg) => {
    const objects = cfg.modResults.hash.project.objects;
    const targetEntry = findByName(objects.PBXNativeTarget, TARGET_NAME);
    if (!targetEntry) {
      throw new Error(
        `${TARGET_NAME} Xcode target was not generated. Register withShareExtensionDisplayName before expo-sharing.`,
      );
    }
    const target = targetEntry[1];
    const configurationList = stripComments(objects.XCConfigurationList)[
      target.buildConfigurationList
    ];
    if (!configurationList) {
      throw new Error(`Could not find build configurations for ${TARGET_NAME}.`);
    }
    const buildConfigurations = stripComments(objects.XCBuildConfiguration);
    for (const reference of configurationList.buildConfigurations ?? []) {
      const buildConfiguration = buildConfigurations[reference.value];
      if (buildConfiguration?.buildSettings) {
        buildConfiguration.buildSettings.INFOPLIST_KEY_CFBundleDisplayName = `"${displayName}"`;
      }
    }
    return cfg;
  });
}

module.exports = function withShareExtensionDisplayName(config) {
  const displayName = config.name;
  return withExtensionDisplayNameBuildSetting(
    withDisplayNamePlist(config, displayName),
    displayName,
  );
};
