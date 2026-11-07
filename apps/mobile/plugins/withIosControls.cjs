"use strict";

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET_NAME = "ExpoWidgetsTarget";
const INTENT_FILE = "T3ControlIntents.swift";
const CONTROLS = ["T3StartTaskControl", "T3OpenAppControl"];

module.exports = function withIosControls(config) {
  const scheme = config.scheme;
  if (typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    throw new Error("Start a task control requires a single app URL scheme.");
  }

  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const widgetRoot = path.join(root, TARGET_NAME);
      const indexPath = path.join(widgetRoot, "index.swift");
      const source = fs.readFileSync(indexPath, "utf8");
      const body = "var body: some Widget {";
      if (!source.includes(body)) {
        throw new Error("Cannot find the Expo widget bundle for the Start a task control.");
      }
      const missing = CONTROLS.filter((control) => !source.includes(`${control}()`));
      if (missing.length > 0) {
        fs.writeFileSync(
          indexPath,
          source.replace(
            body,
            `${body}\n    if #available(iOS 18.0, *) {\n      ${missing.map((control) => `${control}()`).join("\n      ")}\n    }`,
          ),
        );
      }
      const intent = fs
        .readFileSync(path.join(__dirname, "ios", INTENT_FILE), "utf8")
        .replaceAll("__T3_SCHEME__", scheme);
      fs.writeFileSync(path.join(root, INTENT_FILE), intent);
      fs.writeFileSync(path.join(widgetRoot, INTENT_FILE), intent);
      for (const control of CONTROLS) {
        fs.copyFileSync(
          path.join(__dirname, "ios", `${control}.swift`),
          path.join(widgetRoot, `${control}.swift`),
        );
      }
      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = Object.entries(project.pbxNativeTargetSection()).find(
      ([key, value]) => !key.endsWith("_comment") && value.name === TARGET_NAME,
    );
    if (!target) {
      throw new Error("Register withIosControls before expo-widgets.");
    }
    const group = project.getFirstProject().firstProject.mainGroup;
    project.addSourceFile(INTENT_FILE, { target: project.getFirstTarget().uuid }, group);
    for (const file of [INTENT_FILE, ...CONTROLS.map((control) => `${control}.swift`)]) {
      project.addSourceFile(`${TARGET_NAME}/${file}`, { target: target[0] }, group);
    }
    const list = project.pbxXCConfigurationList()[target[1].buildConfigurationList];
    for (const reference of list.buildConfigurations) {
      const settings = project.pbxXCBuildConfigurationSection()[reference.value].buildSettings;
      const flags = settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '"$(inherited)"';
      const values = Array.isArray(flags) ? flags : [flags];
      if (!values.includes("T3_WIDGET_EXTENSION")) {
        settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = [...values, "T3_WIDGET_EXTENSION"];
      }
    }
    return cfg;
  });
};
