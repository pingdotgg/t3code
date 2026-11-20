"use strict";

const { AndroidConfig, withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

// Native copy names the product, not the variant's display name ("T3 Code Dev").
module.exports = function withProductName(config, name) {
  config = withInfoPlist(config, (next) => {
    next.modResults.T3ProductName = name;
    return next;
  });
  return withAndroidManifest(config, (next) => {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      AndroidConfig.Manifest.getMainApplicationOrThrow(next.modResults),
      "t3.productName",
      name,
    );
    return next;
  });
};
