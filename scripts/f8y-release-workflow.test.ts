// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import serverPackageJson from "../apps/server/package.json" with { type: "json" };

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const workflowPath = NodePath.join(repoRoot, ".github/workflows/f8y-release.yml");
const workflow = NodeFS.readFileSync(workflowPath, "utf8");

it("publishes the desktop, mobile, and standalone CLI artifacts for every main push", () => {
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
  assert.include(workflow, "workflow_dispatch:");
  assert.include(workflow, "runs-on: macos-15");
  assert.include(workflow, "runs-on: ubuntu-24.04");
  assert.include(workflow, 'T3CODE_DESKTOP_DISABLE_UPDATE_CONFIG: "true"');
  assert.include(workflow, "T3-Code-${{ needs.metadata_and_checks.outputs.version }}-android.apk");
  assert.include(workflow, "prerelease: true");
  assert.include(workflow, "make_latest: false");
  assert.include(workflow, "release-assets/*.dmg");
  assert.include(workflow, "release-assets/*.dmg.sha256");
  assert.include(workflow, "release-assets/*.apk");
  assert.include(workflow, "release-assets/t3-*-darwin-arm64");
  assert.include(workflow, "release-assets/t3-*-darwin-arm64.sha256");
  assert.include(workflow, "release-assets/t3-*-linux-x64");
  assert.include(workflow, "release-assets/t3-*-linux-x64.sha256");
  assert.notInclude(workflow, "blacksmith-");
  assert.notInclude(workflow, "EXPO_TOKEN");
  assert.notInclude(workflow, "CSC_LINK");
  assert.notInclude(workflow.toLowerCase(), "personal");
});

it("builds and verifies versioned self-contained full CLIs for macOS and Linux", () => {
  const macosBuildScript = serverPackageJson.scripts["build:binary:darwin-arm64"];
  const linuxBuildScript = serverPackageJson.scripts["build:binary:linux-x64"];

  assert.include(macosBuildScript, "vp run --filter @t3tools/web build");
  assert.include(macosBuildScript, "bun scripts/buildStandaloneBinary.ts");
  assert.include(macosBuildScript, "bun-darwin-arm64 dist/t3-darwin-arm64");
  assert.include(linuxBuildScript, "vp run --filter @t3tools/web build");
  assert.include(linuxBuildScript, "bun scripts/buildStandaloneBinary.ts");
  assert.include(linuxBuildScript, "bun-linux-x64-baseline dist/t3-linux-x64");
  assert.include(workflow, "oven-sh/setup-bun@v2");
  assert.include(workflow, "bun-version: 1.3.14");
  assert.include(workflow, "vp run --filter t3 build:binary:darwin-arm64");
  assert.include(workflow, "vp run --filter t3 build:binary:linux-x64");
  assert.include(workflow, 'cli="apps/server/dist/t3-darwin-arm64"');
  assert.include(workflow, 'cli="apps/server/dist/t3-linux-x64"');
  assert.include(workflow, 'cli_version="$("$cli" --version)"');
  assert.include(workflow, '"$cli" remote --help');
  assert.include(workflow, '"$cli" serve --help');
  assert.include(workflow, '"$cli" service --help');
  assert.include(workflow, 'codesign --force --sign - "$cli"');
  assert.include(workflow, 'shasum -a 256 "$(basename "$cli_asset")"');
  assert.include(workflow, 'sha256sum "$(basename "$cli_asset")"');
  assert.include(
    workflow,
    'cli_asset="release-publish/t3-${{ needs.metadata_and_checks.outputs.version }}-darwin-arm64"',
  );
  assert.include(
    workflow,
    'cli_asset="release-publish/t3-${{ needs.metadata_and_checks.outputs.version }}-linux-x64"',
  );
  assert.match(
    workflow,
    /build_linux_x64:[\s\S]*?needs: metadata_and_checks[\s\S]*?runs-on: ubuntu-24\.04/u,
  );
  assert.include(
    workflow,
    "needs: [metadata_and_checks, build_macos_arm64, build_linux_x64, build_android_apk]",
  );
});

it("ad-hoc-signs and integrity-checks the account-free macOS release", () => {
  assert.include(workflow, 'T3CODE_DESKTOP_AD_HOC_SIGN: "true"');
  assert.include(workflow, 'hdiutil verify "$dmg"');
  assert.include(workflow, 'codesign --verify --deep --strict --verbose=2 "$app"');
  assert.include(workflow, "Signature=adhoc");
  assert.include(workflow, 'shasum -a 256 "$(basename "$dmg")"');
  assert.include(workflow, 'bundle_id" != "com.f8y.t3code"');
  assert.include(workflow, "Privacy & Security → Open Anyway");
  assert.notInclude(workflow, "notarytool");
  assert.notInclude(workflow, "stapler");
  assert.notInclude(workflow, "--signed");
});

it("cancels an in-progress f8y release when a newer one is queued", () => {
  assert.match(workflow, /concurrency:\n\s+group: f8y-release\n\s+cancel-in-progress: true/u);
});

it("evaluates the f8y Expo config before starting release builds", () => {
  const metadataChecks = workflow.slice(
    workflow.indexOf("  metadata_and_checks:"),
    workflow.indexOf("  build_macos_arm64:"),
  );

  assert.include(metadataChecks, "name: Validate f8y Expo config");
  assert.include(metadataChecks, "working-directory: apps/mobile");
  assert.include(metadataChecks, "APP_VARIANT: f8y");
  assert.include(metadataChecks, "T3CODE_RELEASE_VERSION: ${{ steps.metadata.outputs.version }}");
  assert.include(
    metadataChecks,
    "T3CODE_ANDROID_VERSION_CODE: ${{ steps.metadata.outputs.android_version_code }}",
  );
  assert.include(metadataChecks, "./node_modules/.bin/expo config --json >/dev/null");
});

it("uses a stable f8y keystore and validates Android package metadata", () => {
  assert.include(workflow, "F8Y_ANDROID_KEYSTORE_BASE64");
  assert.include(workflow, "F8Y_ANDROID_STORE_PASSWORD");
  assert.include(workflow, "F8Y_ANDROID_KEY_PASSWORD");
  assert.include(workflow, "name='com.f8y.t3code'");
  assert.include(
    workflow,
    "versionCode='${{ needs.metadata_and_checks.outputs.android_version_code }}'",
  );
  assert.include(workflow, 'apksigner" verify --verbose --print-certs');
  assert.include(workflow, "s/^.*certificate SHA-256 digest: //p");
  assert.notInclude(workflow, "s/^Signer #1 certificate SHA-256 digest: //p");
  assert.include(workflow, "Signing certificate differs from the previous f8y APK.");
  assert.include(workflow, "previous_version_code >= current_version_code");
});

it("keeps GitHub write access isolated to the publishing job", () => {
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(
    workflow,
    /publish_release:[\s\S]*?permissions:\n\s+contents: write[\s\S]*?softprops\/action-gh-release@v2/u,
  );
});
