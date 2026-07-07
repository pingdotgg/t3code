"use strict";

// Ships the branded T3 mark to the Live Activity / widget extension.
//
// expo-widgets generates ExpoWidgetsTarget without a Resources build phase and
// has no asset support, so this plugin (a) writes an SVG template image set into
// the generated widget asset catalog and (b) wires that catalog into the widget
// target with a dedicated Resources build phase. Both steps are idempotent and
// survive `expo prebuild --clean`. Must be listed AFTER "expo-widgets" in the
// plugins array so the widget target exists when this runs.

const path = require("path");
const fs = require("fs");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { addWidgetAssetCatalog } = require("./lib/addWidgetAssetCatalog.cjs");

const TARGET_NAME = "ExpoWidgetsTarget";
const CATALOG_NAME = "Assets.xcassets";
const IMAGE_SET = "T3Mark.imageset";
const SVG_NAME = "T3Mark.svg";

const CATALOG_CONTENTS = JSON.stringify({ info: { author: "expo", version: 1 } }, null, 2) + "\n";
const IMAGE_SET_CONTENTS =
  JSON.stringify(
    {
      images: [{ idiom: "universal", filename: SVG_NAME }],
      info: { author: "expo", version: 1 },
      properties: {
        "preserves-vector-representation": true,
        "template-rendering-intent": "template",
      },
    },
    null,
    2,
  ) + "\n";

function withAssetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const source = path.join(cfg.modRequest.projectRoot, "assets", "widget", SVG_NAME);
      const catalogDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, CATALOG_NAME);
      const imageSetDir = path.join(catalogDir, IMAGE_SET);
      fs.mkdirSync(imageSetDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "Contents.json"), CATALOG_CONTENTS);
      fs.writeFileSync(path.join(imageSetDir, "Contents.json"), IMAGE_SET_CONTENTS);
      fs.copyFileSync(source, path.join(imageSetDir, SVG_NAME));
      return cfg;
    },
  ]);
}

function withAssetWiring(config) {
  return withXcodeProject(config, (cfg) => {
    addWidgetAssetCatalog(cfg.modResults, { targetName: TARGET_NAME });
    return cfg;
  });
}

module.exports = function withWidgetLogoAsset(config) {
  return withAssetWiring(withAssetFiles(config));
};
