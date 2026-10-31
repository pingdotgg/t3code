"use strict";

// App Shortcuts (Action button, Siri, Spotlight) only register from the app target, so compile the intents there.

const path = require("path");
const fs = require("fs");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const FILE_NAME = "T3AppIntents.swift";
const SOURCE = path.join(__dirname, "ios", FILE_NAME);

function withIntentSource(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const destination = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
        FILE_NAME,
      );
      fs.copyFileSync(SOURCE, destination);
      return cfg;
    },
  ]);
}

function withIntentBuildFile(config) {
  return withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    // Skips the file when a non-clean prebuild already linked it.
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${projectName}/${FILE_NAME}`,
      groupName: projectName,
      project: cfg.modResults,
    });
    return cfg;
  });
}

module.exports = function withIosAppIntents(config) {
  return withIntentBuildFile(withIntentSource(config));
};
