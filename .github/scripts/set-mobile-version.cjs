const fs = require("node:fs");

const CONFIG_PATH = "apps/mobile/app.config.ts";
const VERSION_LINE = /^( {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? ")[^"]+(".*)$/m;

// Replaces one string literal, so the result needs no formatter.
function setMobileVersion(source, version) {
  if (!/^[0-9]+(\.[0-9]+){1,2}$/.test(version)) {
    throw new Error(
      `Version override must contain two or three dot-separated integers; received '${version}'.`,
    );
  }
  if (!VERSION_LINE.test(source)) throw new Error("Could not update app version");
  return source.replace(VERSION_LINE, `$1${version}$2`);
}

if (require.main === module) {
  const { GITHUB_REF_TYPE, GITHUB_REF_NAME } = process.env;
  if (GITHUB_REF_TYPE !== "branch") {
    throw new Error(
      `Version overrides require dispatching this workflow from a branch; received ${GITHUB_REF_TYPE} '${GITHUB_REF_NAME}'.`,
    );
  }
  fs.writeFileSync(
    CONFIG_PATH,
    setMobileVersion(fs.readFileSync(CONFIG_PATH, "utf8"), process.argv[2] ?? ""),
  );
}

module.exports = { setMobileVersion };
