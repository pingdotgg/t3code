"use strict";
const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

// Register before expo-widgets: our mods run after its target generation.
module.exports = function withAgentWidgetRefresh(config) {
  const pushEnvironment = config.extra?.appVariant === "development" ? "development" : "production";
  const eas = config.extra?.eas ?? {};
  const build = eas.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  const extensions = ios.appExtensions ?? [];
  const current = extensions.find((extension) => extension.targetName === "ExpoWidgetsTarget");
  const widgetExtension = {
    ...current,
    targetName: "ExpoWidgetsTarget",
    bundleIdentifier: `${config.ios.bundleIdentifier}.widgets`,
    entitlements: { ...current?.entitlements, "aps-environment": pushEnvironment },
  };
  config.extra = {
    ...config.extra,
    eas: {
      ...eas,
      build: {
        ...build,
        experimental: {
          ...experimental,
          ios: {
            ...ios,
            appExtensions: [
              ...extensions.filter((extension) => extension.targetName !== "ExpoWidgetsTarget"),
              widgetExtension,
            ],
          },
        },
      },
    },
  };

  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const target = path.join(cfg.modRequest.platformProjectRoot, "ExpoWidgetsTarget");
      for (const file of [
        "AgentWidgetTimelineProvider.swift",
        "AgentWidgetState.swift",
        "AgentWidgetCredential.swift",
      ]) {
        const source =
          file === "AgentWidgetCredential.swift"
            ? path.join(__dirname, "..", "modules", "t3-native-controls", "ios", file)
            : path.join(__dirname, "widget", file);
        fs.copyFileSync(source, path.join(target, file));
      }
      const entitlements = path.join(target, "ExpoWidgetsTarget.entitlements");
      const plist = fs.readFileSync(entitlements, "utf8");
      if (!plist.includes("<key>aps-environment</key>"))
        fs.writeFileSync(
          entitlements,
          plist.replace(
            "<dict>",
            `<dict>\n    <key>aps-environment</key>\n    <string>${pushEnvironment}</string>`,
          ),
        );
      if (pushEnvironment === "development") {
        const infoPath = path.join(target, "Info.plist");
        const info = fs.readFileSync(infoPath, "utf8");
        if (!info.includes("<key>NSAppTransportSecurity</key>"))
          fs.writeFileSync(
            infoPath,
            info.replace(
              "<dict>",
              "<dict>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>",
            ),
          );
      }
      const widget = path.join(target, "AgentActivity.swift");
      const source = fs.readFileSync(widget, "utf8");
      const provider = "WidgetsTimelineProvider(name: name)";
      if (!source.includes(provider)) throw new Error("AgentActivity provider generation changed");
      fs.writeFileSync(
        widget,
        source
          .replace(provider, "AgentWidgetTimelineProvider()")
          .replace(
            "    .configurationDisplayName",
            "    .agentWidgetPushHandler()\n    .configurationDisplayName",
          ),
      );
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const target = Object.entries(proj.pbxNativeTargetSection()).find(
      ([key, value]) => !key.endsWith("_comment") && value.name === "ExpoWidgetsTarget",
    );
    if (!target) throw new Error("ExpoWidgetsTarget missing before widget refresh wiring");
    const group = Object.entries(proj.hash.project.objects.PBXGroup).find(
      ([key, value]) =>
        !key.endsWith("_comment") &&
        (value.name === "ExpoWidgetsTarget" || value.path === "ExpoWidgetsTarget"),
    );
    if (!group) throw new Error("ExpoWidgetsTarget source group missing");
    for (const file of [
      "AgentWidgetTimelineProvider.swift",
      "AgentWidgetState.swift",
      "AgentWidgetCredential.swift",
    ]) {
      proj.addSourceFile(file, { target: target[0] }, group[0]);
    }
    return cfg;
  });
};
