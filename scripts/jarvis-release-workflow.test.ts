// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const componentWorkflows = [
  "jarvis-desktop-linux.yml",
  "jarvis-desktop-mac.yml",
  "jarvis-setup-windows.yml",
  "headless-node-release.yml",
] as const;

const readWorkflow = (name: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const stableTagTrigger = /\n  push:\n    tags:\n(?:      - .*\n)+/;
const releaseMutation = /softprops\/action-gh-release|gh release (?:create|upload|edit|delete)/;

describe("Jarvis release workflow contracts", () => {
  it("has one manual coordinator that promotes after all builds", () => {
    const coordinatorPath = new URL("../.github/workflows/jarvis-release.yml", import.meta.url);
    assert.isTrue(NodeFS.existsSync(coordinatorPath), "coordinator workflow is missing");

    const coordinator = NodeFS.readFileSync(coordinatorPath, "utf8");
    assert.include(coordinator, "workflow_dispatch:");
    assert.include(coordinator, "channel:");
    assert.include(coordinator, "- preview");
    assert.include(coordinator, "v${version}-preview.${RELEASE_RUN_NUMBER}");
    assert.isFalse(/^\s{2}push:/m.test(coordinator), "coordinator must be manual-only");

    assert.include(coordinator, "uses: ./.github/workflows/jarvis-desktop-linux.yml");
    assert.include(coordinator, "uses: ./.github/workflows/jarvis-setup-windows.yml");
    assert.include(coordinator, "uses: ./.github/workflows/headless-node-release.yml");
    assert.include(coordinator, "uses: ./.github/workflows/jarvis-companion-release.yml");
    assert.include(coordinator, "JARVIS_COMPANION_VERSION");
    for (const name of [
      "Jarvis-Companion-${COMPANION_VERSION}-x64.exe",
      "Jarvis-Companion-${COMPANION_VERSION}-x64.exe.blockmap",
      "latest.yml",
      "Jarvis-Companion-${COMPANION_VERSION}-x86_64.AppImage",
      "latest-linux.yml",
    ]) {
      assert.include(coordinator, name);
    }

    const preflightStart = coordinator.indexOf("\n  preflight:");
    const firstBuildStart = coordinator.indexOf("\n  build_linux:");
    const preflight = coordinator.slice(preflightStart, firstBuildStart);
    assert.include(
      preflight,
      'node scripts/jarvis-release-transaction.ts preflight "$RELEASE_VERSION" "$GITHUB_SHA"',
    );
    assert.include(preflight, "Apple release credentials");
    assert.include(preflight, "CSC_LINK");
    assert.notInclude(preflight, "CLERK_PUBLISHABLE_KEY or CLERK_PASSKEY_RP_DOMAINS");
    assert.notInclude(preflight, "MACOS_PROVISIONING_PROFILE");
    const nodeSetupIndex = coordinator.indexOf("uses: actions/setup-node@v6");
    const releaseStatePreflightIndex = coordinator.indexOf(
      "name: Preflight existing GitHub release state",
    );
    assert.isAtLeast(nodeSetupIndex, 0, "preflight must pin Node.js from package.json");
    assert.include(coordinator, "node-version-file: package.json");
    assert.isBelow(nodeSetupIndex, releaseStatePreflightIndex);
    assert.notInclude(preflight, "releases?per_page=100");
    assert.notInclude(preflight, "published_count");
    assert.notInclude(preflight, "draft_count");
    assert.notInclude(preflight, ".draft == true");
    assert.notInclude(preflight, "reusable draft release");

    const promoteIndex = coordinator.indexOf("\n  promote:");
    assert.isAtLeast(promoteIndex, 0, "coordinator needs one promote job");
    const promote = coordinator.slice(promoteIndex);
    assert.include(promote, "needs:");
    assert.include(
      promote,
      "needs: [preflight, build_linux, build_windows, build_mac, build_headless, build_companion]",
    );
    assert.include(promote, "build_linux");
    assert.include(promote, "build_windows");
    assert.include(promote, "build_headless");
    assert.include(coordinator, "scripts/jarvis-release-transaction.ts release-assets");
    assert.include(coordinator, "Jarvis-Setup.exe");
    assert.notInclude(coordinator, ".zip");
    assert.include(coordinator, "VERSION: ${{ needs.preflight.outputs.version }}");
    assert.notInclude(coordinator, "\n      RELEASE_TAG:");
    assert.include(coordinator, "Companion Windows artifacts are unsigned");
    assert.include(coordinator, "build_mac:");
    assert.include(coordinator, "jarvis-desktop-mac.yml");
    assert.include(coordinator, "downloads/mac");
    assert.include(coordinator, ".dmg");
    assert.include(coordinator, "JARVIS_RELEASE_PRERELEASE");
    assert.include(coordinator, "JARVIS_RELEASE_MAKE_LATEST");
    const transaction = NodeFS.readFileSync(
      new URL("./jarvis-release-transaction.ts", import.meta.url),
      "utf8",
    );
    assert.include(transaction, "these artifacts are unsigned");
    assert.include(transaction, "Windows SmartScreen");
    assert.include(transaction, "macOS Gatekeeper");
    assert.include(transaction, "Verify the hashes before proceeding");
    assert.include(coordinator, "Existing tag $tag resolves");
    assert.include(
      coordinator,
      'if tag_ref="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" 2>/dev/null)"; then',
    );
    assert.notInclude(coordinator, 'git/ref/tags/$tag" 2>/dev/null || true');
    assert.notInclude(coordinator, "gh release upload");
    assert.notInclude(coordinator, "gh release create");
    assert.notInclude(coordinator, "releases/$RELEASE_ID");
    assert.equal((coordinator.match(/contents:\s*write/g) ?? []).length, 1);
  });

  it("bounds coordinator preflight and promotion jobs", () => {
    const coordinator = NodeFS.readFileSync(
      new URL("../.github/workflows/jarvis-release.yml", import.meta.url),
      "utf8",
    );
    const preflight = coordinator.slice(
      coordinator.indexOf("\n  preflight:"),
      coordinator.indexOf("\n  build_linux:"),
    );
    const promote = coordinator.slice(coordinator.indexOf("\n  promote:"));
    assert.include(preflight, "timeout-minutes: 15");
    assert.include(promote, "timeout-minutes: 30");
  });

  it("checks only the shallow current main ref during preflight", () => {
    const coordinator = NodeFS.readFileSync(
      new URL("../.github/workflows/jarvis-release.yml", import.meta.url),
      "utf8",
    );
    const preflight = coordinator.slice(
      coordinator.indexOf("\n  preflight:"),
      coordinator.indexOf("\n  build_linux:"),
    );
    assert.include(preflight, "ref: refs/heads/main");
    assert.include(preflight, "fetch-depth: 1");
    assert.include(preflight, "fetch-tags: false");
    assert.notInclude(preflight, "fetch-depth: 0");
    assert.include(preflight, "git fetch --force origin refs/heads/main:refs/remotes/origin/main");
    assert.notInclude(preflight, "git fetch --force --tags origin main");
    assert.include(preflight, "git rev-parse refs/remotes/origin/main");
    assert.include(preflight, 'gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag');
  });

  it("keeps component workflows reusable, build-only, and tag-free", () => {
    for (const name of componentWorkflows) {
      const workflow = readWorkflow(name);
      assert.include(workflow, "workflow_call:", `${name} must be reusable`);
      assert.include(workflow, "workflow_dispatch:", `${name} must support manual debugging`);
      assert.isFalse(stableTagTrigger.test(workflow), `${name} must not trigger on stable tags`);
      assert.isFalse(releaseMutation.test(workflow), `${name} must not mutate releases`);
    }
  });

  it("keeps Companion build-only and prevents a second release publisher", () => {
    const workflow = readWorkflow("jarvis-companion-release.yml");
    assert.include(workflow, "workflow_call:");
    assert.include(workflow, "workflow_dispatch:");
    assert.notMatch(workflow, /^\s+push:/m);
    assert.notInclude(workflow, "gh release ");
    assert.notInclude(workflow, "contents: write");
    assert.include(workflow, "public_release:");
    assert.include(
      workflow,
      "Stable Companion publication is closed: Windows artifacts are unsigned.",
    );
    assert.include(
      workflow,
      "Jarvis-Companion-Windows-${{ steps.companion_version.outputs.version }}",
    );
    assert.include(
      workflow,
      "Jarvis-Companion-Linux-${{ steps.companion_version.outputs.version }}",
    );
    assert.include(workflow, "- --filter=@jarvis/companion...");
    assert.include(workflow, "run-install: |\n            args:");
    assert.include(workflow, "apps/companion/src/companion-startup-probe.test.ts");
    assert.include(workflow, "sudo apt-get install -y dbus-x11 libasound2-dev xvfb");
    assert.include(workflow, 'appimage="${appimages[0]}"');
    assert.include(workflow, "setsid --wait dbus-run-session -- env");
    assert.include(workflow, 'xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" \\');
    assert.include(workflow, '"$appimage" --no-sandbox --startup-smoke');
    assert.notInclude(workflow, '"$app" --no-sandbox --startup-smoke');
    assert.include(workflow, "APPIMAGE_EXTRACT_AND_RUN=1");
    assert.include(workflow, 'JARVIS_COMPANION_STARTUP_PROBE_FILE="$receipt_file"');
    assert.include(workflow, 'timeout --signal=TERM 45 tail --pid="$app_pid" -f /dev/null');
    assert.include(workflow, 'receipt_file="$smoke_root/startup-receipt.json"');
    assert.include(workflow, 'if [[ ! -f "$receipt_file" ]]; then');
    assert.include(workflow, "schemaVersion: 1");
    assert.include(workflow, 'product: "Jarvis Companion"');
    assert.include(workflow, 'phase: "tray-ready"');
    assert.notInclude(workflow, "grep -m1 -E '^COMPANION_STARTUP_SMOKE_READY");
    assert.notInclude(workflow, 'IFS= read -r receipt < "$1"');
    assert.notInclude(workflow, 'mkfifo "$output_pipe" "$receipt_pipe"');
    assert.include(workflow, 'kill -TERM -- "-$app_pid"');

    const windowsSmoke = workflow.slice(
      workflow.indexOf("      - name: Smoke installed Companion speech"),
      workflow.indexOf("      - name: Upload test installer"),
    );
    assert.include(windowsSmoke, "function Invoke-CompanionLifecycleProcess");
    assert.include(windowsSmoke, "WaitForExit");
    assert.include(windowsSmoke, "Stop-Process -Id $process.Id");
    assert.include(windowsSmoke, "600000");
    assert.include(windowsSmoke, "120000");
    assert.include(windowsSmoke, "300000");
    assert.notInclude(windowsSmoke, "-Wait");
    assert.include(windowsSmoke, "function Remove-CompanionSmokeInstallRoot");
    assert.include(windowsSmoke, "$deadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)");
    assert.include(windowsSmoke, "Start-Sleep -Milliseconds");
    assert.include(windowsSmoke, "Timed out removing speech smoke install root");
    assert.include(
      windowsSmoke,
      "$resolvedInstallRoot = [System.IO.Path]::GetFullPath($installRoot)",
    );
    assert.notInclude(windowsSmoke, "Resolve-Path -LiteralPath $installRoot");
    assert.include(
      windowsSmoke,
      "Remove-CompanionSmokeInstallRoot -ResolvedInstallRoot $resolvedInstallRoot -TimeoutMilliseconds 120000",
    );
    assert.notInclude(windowsSmoke, "while ($true)");
    assert.notInclude(workflow, "@t3tools/jarvis-native-microphone build:native");
    assert.notInclude(
      workflow,
      "packages/jarvis-native-voice/src/native-microphone-regression.test.ts",
    );
    assert.include(workflow, "node-cpal");
    assert.include(workflow, "typeof loaded.createStream !== 'function'");
    assert.include(workflow, 'native_root="$app_resources/node_modules/node-cpal"');
    assert.include(workflow, 'test -f "$unpacked/resources/icon.png"');
    assert.include(workflow, 'test -f "$native_root/bin/linux-x64/index.node"');
    assert.include(
      workflow,
      'test ! -e "$app_resources/node_modules/@t3tools/jarvis-native-microphone"',
    );
  });

  it("keeps the upstream release graph inert on the fork", () => {
    const workflow = readWorkflow("release.yml");
    assert.include(workflow, "workflow_dispatch:");
    assert.notMatch(workflow, /^\s+(push|schedule):/m);
    assert.include(workflow, "github.repository == 'pingdotgg/t3code'");
    assert.include(workflow, "runs-on: blacksmith-");
    assert.include(workflow, "name: Release quality checks");
  });

  it("uses a shallow checkout for headless packaging", () => {
    const workflow = readWorkflow("headless-node-release.yml");
    assert.include(workflow, "fetch-depth: 1");
    assert.notInclude(workflow, "fetch-depth: 0");
  });

  it("gates public Windows releases on complete Trusted Signing and verifies installed signatures", () => {
    const coordinator = readWorkflow("jarvis-release.yml");
    const preflight = coordinator.slice(
      coordinator.indexOf("  preflight:"),
      coordinator.indexOf("  build_linux:"),
    );
    assert.include(preflight, "Fail closed without complete Azure Trusted Signing credentials");
    for (const name of [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ]) {
      assert.include(preflight, name);
    }
    const windowsCall = coordinator.slice(
      coordinator.indexOf("  build_windows:"),
      coordinator.indexOf("  build_headless:"),
    );
    assert.include(windowsCall, "public_release: ${{ inputs.channel == 'stable' }}");

    const workflow = readWorkflow("jarvis-setup-windows.yml");
    const gate = workflow.slice(
      workflow.indexOf("      - name: Validate Azure Trusted Signing release gate"),
      workflow.indexOf("      - name: Setup Vite+"),
    );
    assert.include(workflow, "public_release:");
    assert.include(gate, "Azure Trusted Signing is only partially configured");
    assert.include(gate, "Public Jarvis releases require all Azure Trusted Signing secrets");
    assert.include(gate, "if (-not $publicRelease)");
    assert.include(gate, "JARVIS_WINDOWS_SIGNING_ENABLED=false");
    assert.include(gate, "JARVIS_WINDOWS_SIGNING_ENABLED");
    const desktopBuildStart = workflow.indexOf("      - name: Build desktop payload directory");
    const desktopBuildEnd = workflow.indexOf(
      "      - name: Stage standalone Windows runtime",
      desktopBuildStart,
    );
    const desktopBuild = workflow.slice(desktopBuildStart, desktopBuildEnd);
    assert.include(desktopBuild, "$buildArgs += '--signed'");
    for (const name of [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ]) {
      assert.include(desktopBuild, name + ": ${{ secrets." + name + " }}");
    }
    assert.include(workflow, "Get-AuthenticodeSignature -LiteralPath $Path");
    assert.include(workflow, "$env:JARVIS_EXPECTED_PUBLISHER");
    assert.include(workflow, "installed Full Jarvis.exe");
    assert.include(workflow, "installed Controller Jarvis.exe");
    assert.include(workflow, "Status -ne 'Valid'");
  });

  it("uses native Mac runners and makes verification fail closed", () => {
    const workflow = readWorkflow("jarvis-desktop-mac.yml");
    assert.include(workflow, "public_release:");
    assert.include(workflow, "default: false");
    assert.include(workflow, "Apple signing configuration is incomplete");
    assert.include(workflow, 'if [[ "$PUBLIC_RELEASE" != "true" ]]');
    assert.include(workflow, 'echo "signed=false" >> "$GITHUB_OUTPUT"');
    assert.include(
      workflow,
      "Public release disabled; continuing with unsigned preview/manual verification.",
    );
    assert.include(workflow, "macOS passkey configuration is incomplete");
    assert.include(
      workflow,
      "No Apple credentials supplied; continuing with unsigned manual verification.",
    );
    assert.include(
      workflow,
      "Public Jarvis macOS release is closed: Apple signing/notarization credentials are missing.",
    );
    assert.include(workflow, "runs-on: ${{ matrix.runner }}");
    assert.include(workflow, "runner: macos-15");
    assert.include(workflow, "runner: macos-15-intel");
    assert.notInclude(workflow, "Rosetta");
    assert.notInclude(workflow, "uses: dtolnay/rust-toolchain@stable");
    assert.notInclude(workflow, "build:native");
    assert.include(workflow, "codesign --verify --deep --strict");
    assert.include(workflow, "spctl --assess --type execute");
    assert.include(workflow, "xcrun stapler validate");
    assert.include(workflow, 'xcrun stapler validate "$artifact"');
    assert.include(workflow, 'if [[ "$JARVIS_MAC_SIGNED" == "true" ]]');
    assert.include(workflow, "args+=(--signed)");
    assert.include(workflow, "passkeys=true");
    assert.include(workflow, "if: ${{ steps.signing.outputs.signed == 'true' }}");
    assert.include(workflow, "scripts/mac-desktop-startup-smoke.mjs");
    assert.include(workflow, "scripts/build-desktop-artifact.test.ts");
    assert.include(workflow, "apps/desktop/src/preload/RendererPcmCapture.test.ts");
    assert.include(workflow, "deterministic fake-media/AudioWorklet lifecycle");
    assert.include(workflow, "Build Full Desktop DMG");
    assert.notInclude(workflow, "Build Full Desktop DMG and ZIP");
    assert.notInclude(workflow, ".zip");
    assert.include(workflow, 'ditto "$mounted_app" "$copied_app"');
    assert.include(workflow, 'hdiutil detach "$mount_root" -quiet');
    assert.notInclude(workflow, 'device="$(awk');
    assert.include(workflow, "mounted=false");
    assert.include(workflow, "mounted=true");
    assert.include(workflow, 'if [[ "$mounted" == "true" ]]');
    assert.include(workflow, "Refusing to remove the still-mounted DMG");
    const copyIndex = workflow.indexOf('ditto "$mounted_app" "$copied_app"');
    const detachIndex = workflow.indexOf('hdiutil detach "$mount_root" -quiet', copyIndex);
    const launchIndex = workflow.indexOf("scripts/mac-desktop-startup-smoke.mjs", detachIndex);
    assert.isAtLeast(copyIndex, 0, "DMG contents must be copied before launch");
    assert.isAtLeast(detachIndex, 0, "DMG must be detached by mountpoint");
    assert.isBelow(copyIndex, detachIndex, "DMG must be copied before unmounting");
    assert.isBelow(detachIndex, launchIndex, "LaunchServices smoke must run after unmounting");
    assert.include(
      workflow,
      'application_root="$RUNNER_TEMP/jarvis-applications-${{ matrix.arch }}"',
    );
    assert.notInclude(workflow, "Contents/MacOS/Jarvis");
    assert.include(workflow, "Contents/Resources/jarvis-official-release.json");
    assert.include(workflow, "Upload Mac startup log on failure");
    assert.include(workflow, "if: ${{ failure() }}");
    assert.include(workflow, "jarvis-mac-startup-${{ matrix.arch }}-${{ github.run_id }}");
    assert.notInclude(workflow, "sleep 1");
    assert.notInclude(workflow, "for _ in $(seq");
    const checksumStart = workflow.indexOf("      - name: Write Mac checksums and provenance");
    const uploadStart = workflow.indexOf(
      "      - name: Upload Mac desktop artifacts",
      checksumStart,
    );
    const checksumStep = workflow.slice(checksumStart, uploadStart);
    assert.include(checksumStep, "node -e");
    assert.notInclude(checksumStep, "<<'NODE'");
    assert.include(checksumStep, "done");
  });

  it("builds and verifies the registry node-cpal binding on Linux and Windows targets", () => {
    const linux = readWorkflow("jarvis-desktop-linux.yml");
    const mac = readWorkflow("jarvis-desktop-mac.yml");
    const windows = readWorkflow("jarvis-setup-windows.yml");
    for (const workflow of [linux, windows]) {
      assert.include(workflow, "node-cpal");
      assert.include(workflow, "typeof loaded.createStream !== 'function'");
      assert.include(workflow, "uiohook-napi");
      assert.include(workflow, "typeof loaded.start !== 'function'");
      assert.include(workflow, "typeof loaded.stop !== 'function'");
      assert.notInclude(workflow, "typeof loaded.uIOhook !== 'object'");
      assert.notInclude(workflow, "@t3tools/jarvis-native-microphone build:native");
      assert.notInclude(workflow, "native-microphone-regression.test.ts");
    }
    const linuxNodeCpalElectronNodeModeProbes = linux
      .split("\n")
      .filter((line) => line.includes("ELECTRON_RUN_AS_NODE=1") && line.includes("createStream"));
    assert.lengthOf(linuxNodeCpalElectronNodeModeProbes, 1);
    assert.notInclude(linuxNodeCpalElectronNodeModeProbes[0], "--no-sandbox");
    assert.include(
      linuxNodeCpalElectronNodeModeProbes[0],
      "typeof loaded.createStream !== 'function'",
    );
    const linuxUiohookProbeStart = linux.indexOf(
      'xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24"',
    );
    assert.isAtLeast(linuxUiohookProbeStart, 0);
    const linuxUiohookProbe = linux.slice(linuxUiohookProbeStart, linuxUiohookProbeStart + 1_000);
    assert.include(linuxUiohookProbe, "env ELECTRON_RUN_AS_NODE=1");
    assert.include(linuxUiohookProbe, "typeof loaded.start !== 'function'");
    assert.include(linuxUiohookProbe, "typeof loaded.stop !== 'function'");
    assert.notInclude(linuxUiohookProbe, "--no-sandbox");
    assert.include(mac, "Prepare shared native voice resources for macOS Desktop");
    assert.include(mac, "--voice-resources-dir packages/jarvis-native-voice/resources");
    for (const entry of [
      "parakeet/encoder.int8.onnx",
      "parakeet/decoder.int8.onnx",
      "parakeet/joiner.int8.onnx",
      "parakeet/tokens.txt",
      "pocket/models/flow_lm_main_int8.onnx",
      "pocket/voices/alba-casual-3s.wav",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.include(mac, entry);
    }
    assert.include(mac, "sherpa-onnx-darwin-${{ matrix.arch }}/sherpa-onnx.node");
    assert.include(mac, "Unexpected sherpa target directory staged on macOS");
    assert.include(mac, "NSMicrophoneUsageDescription");
    assert.notInclude(mac, "node-cpal/bin/");
    assert.notInclude(mac, "@t3tools/jarvis-native-microphone/bin/");
    assert.include(mac, "node_modules/uiohook-napi");
    assert.include(linux, "bin/linux-x64/index.node");
    assert.include(windows, "bin\\win32-x64\\index.node");
    assert.include(linux, "resources/jarvis-official-release.json");
    assert.include(mac, "Contents/Resources/jarvis-official-release.json");
  });
});
