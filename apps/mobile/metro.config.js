const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const extraThemes = require("./generated-uniwind-theme-names.json");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const generatedLicenseModuleRoot = path.join(__dirname, ".generated", "third-party-licenses");
const licenseGeneratorSource = path.join(
  workspaceRoot,
  "scripts",
  "lib",
  "third-party-licenses.ts",
);
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const generatedDeviceStreamRoot = path.join(__dirname, ".generated", "device-stream");
const generatedPreviewStreamRoot = path.join(__dirname, ".generated", "preview-stream");
const rebrandedTranslationsRoot = path.join(__dirname, ".generated", "rebrand", "translations");

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
    "@t3tools/mobile-preview-stream": generatedPreviewStreamRoot,
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

async function prepareStreamScripts() {
  const { generateDeviceStreamScript, generatePreviewStreamScript } = await import(
    pathToFileURL(path.join(__dirname, "scripts", "generate-device-stream.mts")).href
  );
  const generateAll = () =>
    Promise.all([generateDeviceStreamScript(), generatePreviewStreamScript()]);
  await generateAll();
  if (process.env.NODE_ENV !== "production") {
    let rebuild = Promise.resolve();
    for (const [directory, files, generate] of [
      [
        "apps/mobile/src/features/devices",
        ["device-stream.browser.ts"],
        generateDeviceStreamScript,
      ],
      [
        "apps/mobile/src/features/browser",
        ["preview-stream.browser.ts"],
        generatePreviewStreamScript,
      ],
      ["packages/client-runtime/src/device", ["stream.ts", "hubAccess.ts"], generateAll],
      [
        "packages/client-runtime/src/preview",
        ["serverBrowserStream.ts"],
        generatePreviewStreamScript,
      ],
    ]) {
      fs.watch(path.join(workspaceRoot, directory), { persistent: false }, (_event, filename) => {
        if (filename && !files.includes(String(filename))) return;
        rebuild = rebuild
          .then(generate)
          .then(() => undefined)
          .catch((error) => {
            console.error("Could not rebuild a WebView stream script:", error);
          });
      });
    }
  }
}

// Metro reads JSON without Babel, so a standalone build serves catalogs keyed by its renamed source.
async function rebrandTranslationCatalogs() {
  const importScript = (name) =>
    import(pathToFileURL(path.join(workspaceRoot, "scripts", "lib", name)).href);
  const [{ loadRepoEnv }, { rebrandName, rebrandCatalogFile }] = await Promise.all([
    importScript("public-config.ts"),
    importScript("rebrand.ts"),
  ]);
  const repoEnv = loadRepoEnv();
  const name = rebrandName(repoEnv);
  if (!name) return;
  // babel.config.js renames the source in Metro's workers, which inherit this environment.
  process.env.T3CODE_STANDALONE = repoEnv.T3CODE_STANDALONE;
  process.env.T3CODE_APP_NAME = repoEnv.T3CODE_APP_NAME;
  config.cacheVersion = `${config.cacheVersion ?? ""}:${name}`;
  const sourceDir = path.join(__dirname, "src", "i18n", "translations");
  await fs.promises.mkdir(rebrandedTranslationsRoot, { recursive: true });
  for (const file of await fs.promises.readdir(sourceDir)) {
    const catalog = rebrandCatalogFile(path.join(sourceDir, file), name);
    if (catalog) {
      await writeFileIfChanged(path.join(rebrandedTranslationsRoot, file), JSON.stringify(catalog));
    }
  }
  const i18nProvider = path.join(__dirname, "src", "i18n", "I18nProvider.tsx");
  const resolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const catalog = /^\.\/translations\/([\w-]+\.json)$/.exec(moduleName)?.[1];
    if (catalog && context.originModulePath === i18nProvider) {
      return { type: "sourceFile", filePath: path.join(rebrandedTranslationsRoot, catalog) };
    }
    return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = Promise.all([
  generateMobileThirdPartyLicenses(),
  prepareStreamScripts(),
  rebrandTranslationCatalogs(),
]).then(() =>
  withUniwindConfig(config, {
    cssEntryFile: "./global.css",
    extraThemes,
    polyfills: { rem: 14 },
  }),
);
