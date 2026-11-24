"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig,
} = require("expo/config-plugins");

const ACTIVITY_TYPES = ["com.t3tools.t3code.view-thread", "com.t3tools.t3code.view-project"];

const PACKAGE_BRIDGE_FILENAME = "T3AppIntentsPackageBridge.swift";
const PACKAGE_BRIDGE_SOURCE = `import AppIntents
import T3AppleIntents

/// Links the CocoaPods T3AppleIntents AppIntentsPackage into the main app target so Xcode's
/// appintentsmetadataprocessor extracts all 27.3 tools, entities, and shortcuts into the app bundle.
struct T3MobileAppIntentsPackage: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] {
    [T3IntentsCorePackage.self]
  }
}
`;

const SKILLS_BUNDLE_NAME = "Skills.skillsbundle";

function withAppleIntentsInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    const existing = Array.isArray(cfg.modResults.NSUserActivityTypes)
      ? cfg.modResults.NSUserActivityTypes
      : [];
    const merged = [...existing];
    for (const activityType of ACTIVITY_TYPES) {
      if (!merged.includes(activityType)) {
        merged.push(activityType);
      }
    }
    cfg.modResults.NSUserActivityTypes = merged;
    const bundleId = cfg.ios?.bundleIdentifier ?? "com.t3tools.t3code";
    cfg.modResults.T3AppGroupIdentifier = `group.${bundleId}`;
    return cfg;
  });
}

function copyDirectoryRecursive(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function withAppleIntentsFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const projectName = cfg.modRequest.projectName;
      const appTargetDir = path.join(cfg.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(appTargetDir, { recursive: true });

      fs.writeFileSync(
        path.join(appTargetDir, PACKAGE_BRIDGE_FILENAME),
        PACKAGE_BRIDGE_SOURCE,
        "utf8",
      );

      const skillsSource = path.resolve(
        cfg.modRequest.projectRoot,
        "..",
        "..",
        "native",
        "apple-intents",
        SKILLS_BUNDLE_NAME,
      );
      if (!fs.existsSync(skillsSource)) {
        throw new Error(`withAppleIntents: missing ${skillsSource}`);
      }
      copyDirectoryRecursive(skillsSource, path.join(appTargetDir, SKILLS_BUNDLE_NAME));
      return cfg;
    },
  ]);
}

function withAppleIntentsXcodeProject(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const targetUuid = project.getFirstTarget().uuid;

    // Register T3AppIntentsPackageBridge.swift in the main app target's Compile Sources phase.
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/${PACKAGE_BRIDGE_FILENAME}`,
      groupName: projectName,
      project,
      targetUuid,
    });

    // Register Skills.skillsbundle in the main app target's Resources phase as wrapper.skillsbundle.
    const resourcePath = `${projectName}/${SKILLS_BUNDLE_NAME}`;
    if (!project.hasFile(resourcePath)) {
      const groupKey = project.findPBXGroupKey({ name: projectName });
      const addedFile = project.addResourceFile(
        resourcePath,
        { target: targetUuid, lastKnownFileType: "wrapper.skillsbundle" },
        groupKey,
      );
      if (addedFile && addedFile.fileRef) {
        const fileRefs = project.pbxFileReferenceSection();
        if (fileRefs[addedFile.fileRef]) {
          fileRefs[addedFile.fileRef].lastKnownFileType = "wrapper.skillsbundle";
        }
      }
    }

    // Ensure App Intents metadata extraction is enabled on all main target configurations.
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const [key, value] of Object.entries(configurations)) {
      if (key.endsWith("_comment") || !value || !value.buildSettings) continue;
      if (value.buildSettings.PRODUCT_BUNDLE_IDENTIFIER || value.buildSettings.INFOPLIST_FILE) {
        value.buildSettings.ENABLE_APPINTENTS_METADATA_GENERATION = "YES";
      }
    }

    return cfg;
  });
}

module.exports = function withAppleIntents(config) {
  return withAppleIntentsXcodeProject(withAppleIntentsFiles(withAppleIntentsInfoPlist(config)));
};
