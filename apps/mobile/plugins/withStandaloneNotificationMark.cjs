"use strict";

// App resources override same-named library resources, so this replaces the T3 mark that the
// t3-agent-notifications module ships, without editing the module.

const path = require("path");
const fs = require("fs");
const { withDangerousMod } = require("expo/config-plugins");

module.exports = function withStandaloneNotificationMark(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const source = path.join(
        cfg.modRequest.projectRoot,
        "..",
        "..",
        "assets",
        "easydev",
        "agent_activity_mark.xml",
      );
      const targetDir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res/drawable");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, path.join(targetDir, "agent_activity_mark.xml"));
      return cfg;
    },
  ]);
};
