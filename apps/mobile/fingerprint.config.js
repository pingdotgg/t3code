// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Expo's fingerprint ignores the app version, so binaries of different majors
// share a runtime version whenever native code is unchanged, and a production
// OTA from main would reach every older store binary. Hashing the major
// version keeps each major's OTAs on its own binaries: a new major reaches
// users only once its store build is promoted.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const majorVersion = appConfig.match(/^ {2}version: "(\d+)\./m)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

module.exports = {
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
};
