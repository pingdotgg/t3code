const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const extraThemes = require("./generated-uniwind-theme-names.json");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
// Expo finds Worklets' versionless lib/module/package.json. Use the package root
// so upgrades invalidate cached worklets compiled for the previous runtime.
config.transformer.workletsVersion = require("react-native-worklets/package.json").version;
const workspaceRoot = path.resolve(__dirname, "../..");
const generatedLicenseModuleRoot = path.join(__dirname, ".generated", "third-party-licenses");
const licenseGeneratorSource = path.join(
  workspaceRoot,
  "scripts",
  "lib",
  "third-party-licenses.ts",
);
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const generatedDeviceStreamRoot = path.join(__dirname, ".generated", "device-stream");
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver = {
  ...config.resolver,
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    "@t3tools/mobile-third-party-licenses": generatedLicenseModuleRoot,
    "@t3tools/mobile-device-stream": generatedDeviceStreamRoot,
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

async function writeFileIfChanged(filePath, contents) {
  try {
    if ((await fs.promises.readFile(filePath, "utf8")) === contents) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.promises.writeFile(filePath, contents, "utf8");
}

async function generateMobileThirdPartyLicenses() {
  await fs.promises.mkdir(generatedLicenseModuleRoot, { recursive: true });
  const generatorVersion = (await fs.promises.stat(licenseGeneratorSource)).mtimeMs;
  const { generateThirdPartyLicenseManifest } = await import(
    `${pathToFileURL(licenseGeneratorSource).href}?version=${String(generatorVersion)}`
  );
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: path.join(workspaceRoot, "third-party-licenses.config.json"),
    packageManifests: [{ bundle: "mobile", path: path.join(__dirname, "package.json") }],
    allowMissingGeneratedNotices:
      process.env.NODE_ENV !== "production" &&
      process.env.EAS_BUILD !== "true" &&
      process.env.T3CODE_LICENSES_STRICT !== "1",
  });

  await Promise.all([
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "index.js"),
      `module.exports = ${JSON.stringify(manifest)};\n`,
    ),
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "package.json"),
      '{"main":"index.js"}\n',
    ),
  ]);
}

async function prepareDeviceStream() {
  const { generateDeviceStreamScript } = await import(
    pathToFileURL(path.join(__dirname, "scripts", "generate-device-stream.mts")).href
  );
  await generateDeviceStreamScript();
  if (process.env.NODE_ENV !== "production") {
    let rebuild = Promise.resolve();
    for (const [directory, files] of [
      [path.join(__dirname, "src/features/devices"), ["device-stream.browser.ts"]],
      [
        path.join(workspaceRoot, "packages/client-runtime/src/device"),
        ["stream.ts", "hubAccess.ts"],
      ],
    ]) {
      // The generated module participates in Metro's normal Fast Refresh.
      fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename && !files.includes(String(filename))) return;
        rebuild = rebuild.then(generateDeviceStreamScript).catch((error) => {
          console.error("Could not rebuild the device stream:", error);
        });
      });
    }
  }
}

module.exports = Promise.all([generateMobileThirdPartyLicenses(), prepareDeviceStream()]).then(() =>
  withUniwindConfig(config, {
    cssEntryFile: "./global.css",
    extraThemes,
    polyfills: { rem: 14 },
  }),
);
