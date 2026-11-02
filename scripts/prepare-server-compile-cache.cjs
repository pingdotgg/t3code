/* oxlint-disable t3code/no-global-process-runtime -- Packaging must compare the build host with the executable target. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// afterPack runs before signing and installer creation, against the final ASAR layout.
module.exports = async ({ appOutDir, electronPlatformName, arch, packager }) => {
  // Linux packaging and relocated AppImage cache reuse still need native validation.
  if (electronPlatformName !== "darwin" && electronPlatformName !== "win32") {
    console.log(`[server-compile-cache] Skipping unsupported target ${electronPlatformName}`);
    return;
  }
  const targetArch = ["ia32", "x64", "armv7l", "arm64", "universal"][arch];
  if (electronPlatformName !== process.platform || targetArch !== process.arch) {
    console.log(
      `[server-compile-cache] Skipping unexecutable target ${electronPlatformName}/${targetArch}`,
    );
    return;
  }
  const product = packager.appInfo.productFilename;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const executable =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : path.join(
          appOutDir,
          electronPlatformName === "win32" ? `${product}.exe` : packager.executableName,
        );
  const helper = path.join(
    resources,
    "app.asar",
    "apps/desktop/dist-electron/serverCompileCache.cjs",
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_") || name.startsWith("T3CODE_")) delete env[name];
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "t3-release-cache-"));
  env.T3CODE_HOME = state;
  let result;
  try {
    result = spawnSync(
      executable,
      [
        "-e",
        `require(${JSON.stringify(helper)}).generatePreparedServerCache(${JSON.stringify(resources)}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`,
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  if (result.status !== 0)
    throw new Error(`Server compile cache generation failed: ${result.error || result.stderr}`);
  console.log("[server-compile-cache] Prepared server bytecode with packaged Electron");
};
