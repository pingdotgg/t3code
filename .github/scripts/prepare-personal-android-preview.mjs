import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceRootArgument, versionCodeArgument] = process.argv.slice(2);

if (!sourceRootArgument || !versionCodeArgument) {
  throw new Error(
    "Usage: prepare-personal-android-preview.mjs <source-root> <version-code>",
  );
}

const sourceRoot = path.resolve(sourceRootArgument);
const versionCode = Number(versionCodeArgument);

if (
  !Number.isSafeInteger(versionCode) ||
  versionCode < 1 ||
  versionCode > 2_100_000_000
) {
  throw new Error(`Invalid Android version code: ${versionCodeArgument}`);
}

function replaceOnce(contents, search, replacement, label) {
  const firstIndex = contents.indexOf(search);
  const lastIndex = contents.lastIndexOf(search);

  if (firstIndex === -1) {
    throw new Error(`Could not find ${label}`);
  }

  if (firstIndex !== lastIndex) {
    throw new Error(`Found ${label} more than once`);
  }

  return `${contents.slice(0, firstIndex)}${replacement}${contents.slice(firstIndex + search.length)}`;
}

const manifestPath = path.join(
  sourceRoot,
  "apps/mobile/android/app/src/main/AndroidManifest.xml",
);
const buildGradlePath = path.join(
  sourceRoot,
  "apps/mobile/android/app/build.gradle",
);

let manifest = await readFile(manifestPath, "utf8");
manifest = replaceOnce(
  manifest,
  '<meta-data android:name="expo.modules.updates.ENABLED" android:value="true"/>',
  '<meta-data android:name="expo.modules.updates.ENABLED" android:value="false"/>',
  "enabled Expo updates metadata",
);
await writeFile(manifestPath, manifest);

let buildGradle = await readFile(buildGradlePath, "utf8");

if (
  !buildGradle.includes("namespace 'com.t3tools.t3code.preview'") ||
  !buildGradle.includes("applicationId 'com.t3tools.t3code.preview'")
) {
  throw new Error("Refusing to sign a build that is not the Android preview variant");
}

const versionCodeMatches = [...buildGradle.matchAll(/^\s*versionCode \d+$/gm)];
if (versionCodeMatches.length !== 1) {
  throw new Error(
    `Expected one generated versionCode declaration, found ${versionCodeMatches.length}`,
  );
}
buildGradle = buildGradle.replace(
  versionCodeMatches[0][0],
  `        versionCode ${versionCode}`,
);

buildGradle = replaceOnce(
  buildGradle,
  "    signingConfigs {\n        debug {",
  `    signingConfigs {
        previewRelease {
            storeFile file(System.getenv("T3CODE_PREVIEW_KEYSTORE_FILE"))
            storePassword System.getenv("T3CODE_PREVIEW_KEYSTORE_PASSWORD")
            keyAlias "t3code-preview"
            keyPassword System.getenv("T3CODE_PREVIEW_KEYSTORE_PASSWORD")
        }
        debug {`,
  "generated Android signingConfigs block",
);

const releaseBlockIndex = buildGradle.indexOf("        release {");
const releaseSigning = "            signingConfig signingConfigs.debug";
const releaseSigningIndex = buildGradle.indexOf(
  releaseSigning,
  releaseBlockIndex,
);

if (releaseBlockIndex === -1 || releaseSigningIndex === -1) {
  throw new Error("Could not find the generated release signing configuration");
}

buildGradle = `${buildGradle.slice(0, releaseSigningIndex)}            signingConfig signingConfigs.previewRelease${buildGradle.slice(releaseSigningIndex + releaseSigning.length)}`;
await writeFile(buildGradlePath, buildGradle);

console.log(
  `Prepared com.t3tools.t3code.preview versionCode ${versionCode} with private signing and official OTA updates disabled.`,
);
