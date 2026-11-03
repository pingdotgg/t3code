// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const version =
  process.env.T3CODE_MOBILE_VERSION ??
  appConfig.match(/^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "([^"]+)"/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [
    { type: "contents", id: "appMajorVersion", contents: majorVersion },
    // The controls plugin copies these native inputs outside Expo's module tracking.
    ...[
      "plugins/ios/T3ControlIntents.swift",
      "plugins/ios/T3StartTaskControl.swift",
      "plugins/ios/T3OpenAppControl.swift",
      "assets/widget/T3Mark.svg",
    ].map((filePath) => ({ type: "file", filePath })),
  ],
};
