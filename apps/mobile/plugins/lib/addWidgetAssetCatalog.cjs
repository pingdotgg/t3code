"use strict";

// xcodebuild ignores Resources phases on expo-widgets targets; compile assets in a shell phase.

const PHASE_NAME = "Compile Widget Assets";

const ACTOOL_SCRIPT = [
  "set -e",
  'CATALOG="${SRCROOT}/ExpoWidgetsTarget/Assets.xcassets"',
  'if [ ! -d "$CATALOG" ]; then',
  '  echo "error: widget asset catalog not found at $CATALOG (expo-widgets wiped it? check plugin ordering in app.config.ts)"',
  "  exit 1",
  "fi",
  'DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"',
  'mkdir -p "$DEST"',
  'xcrun actool "$CATALOG" --compile "$DEST" --platform "${PLATFORM_NAME}" --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-16.0}" --output-format human-readable-text',
].join("\n");

function stripComments(map) {
  const out = {};
  for (const key of Object.keys(map || {})) {
    if (key.endsWith("_comment")) continue;
    out[key] = map[key];
  }
  return out;
}

function findByName(map, name) {
  for (const [uuid, value] of Object.entries(stripComments(map))) {
    if (value && value.name === name) return { uuid, value };
  }
  return null;
}

/** @param {import('xcode').XcodeProject} proj
 * @param {{ targetName: string }} opts */
function addWidgetAssetCatalog(proj, opts) {
  const objects = proj.hash.project.objects;
  const target = findByName(objects.PBXNativeTarget, opts.targetName);
  if (!target) {
    throw new Error(
      `addWidgetAssetCatalog: target "${opts.targetName}" not found — ` +
        "withWidgetLogoAsset must be registered before expo-widgets so its " +
        "xcodeproj mod runs after the widget target is created.",
    );
  }

  const phases = target.value.buildPhases || [];
  const existing = objects.PBXShellScriptBuildPhase || {};
  const already = Object.entries(stripComments(existing)).some(
    ([uuid, value]) =>
      value && value.name === `"${PHASE_NAME}"` && phases.some((p) => p.value === uuid),
  );
  if (already) return false;

  const { uuid } = proj.addBuildPhase([], "PBXShellScriptBuildPhase", PHASE_NAME, target.uuid, {
    shellPath: "/bin/sh",
    shellScript: ACTOOL_SCRIPT,
  });
  objects.PBXShellScriptBuildPhase[uuid].alwaysOutOfDate = 1;
  return true;
}

module.exports = { addWidgetAssetCatalog };
