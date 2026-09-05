// @effect-diagnostics nodeBuiltinImport:off - this regression test inspects the
// Companion command surfaces without importing Electron's main process.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

const mainSource = NodeFS.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const trayIconSource = NodeFS.readFileSync(new URL("./tray-icon.ts", import.meta.url), "utf8");
const packageSource = NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8");
const releaseWorkflowSource = NodeFS.readFileSync(
  new URL("../../../.github/workflows/jarvis-companion-release.yml", import.meta.url),
  "utf8",
);
const preloadSource = NodeFS.readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
const relayPreloadSource = NodeFS.readFileSync(
  new URL("./relay-preload.ts", import.meta.url),
  "utf8",
);
const reporterSource = NodeFS.readFileSync(
  new URL("../../web/src/components/jarvis/JarvisVoiceReporter.tsx", import.meta.url),
  "utf8",
);

describe("companion speech interruption wiring", () => {
  it("exposes interruption on the voice surface and tray, not the report relay", () => {
    assert.include(
      preloadSource,
      'interruptSpeech: () => ipcRenderer.invoke("jarvis-companion:interrupt-speech")',
    );
    assert.include(mainSource, "ipcMain.handle(INTERRUPT_SPEECH_CHANNEL");
    assert.include(mainSource, 'interruptCompanionSpeech("overlay")');
    assert.include(mainSource, 'interruptCompanionSpeech("capture")');
    assert.include(mainSource, 'label: "Stop speaking"');
    assert.include(mainSource, "enabled: isNativeSpeechActive()");
    assert.notInclude(relayPreloadSource, "interruptSpeech");
    assert.notInclude(relayPreloadSource, "interrupt-speech");
  });

  it("warms Pocket only after this device wins the Host speaker claim", () => {
    assert.include(relayPreloadSource, "jarvis-companion:prepare-speech");
    const claim = reporterSource.indexOf("const claimReport = () =>");
    const claimResult = reporterSource.indexOf("const claimResult = await claimReport()", claim);
    const alreadySpoken = reporterSource.indexOf(
      'candidate.speechState === "already-spoken"',
      claim,
    );
    const seen = reporterSource.indexOf("readSeenReports().has(reportKey)", claimResult);
    const prepare = reporterSource.indexOf("prepareSpeech?.()", claimResult);
    const speak = reporterSource.indexOf("speakReport(environmentId, report", prepare);
    assert.isAtLeast(claim, 0);
    assert.isAbove(claimResult, claim);
    assert.isAbove(alreadySpoken, claim);
    assert.isAbove(seen, claimResult);
    assert.isAbove(prepare, seen);
    assert.isAbove(speak, prepare);
    assert.include(
      reporterSource,
      'claim.speechState === "already-spoken" || claim.speechState === "missing"',
      "A report already spoken by another surface must not be spoken again.",
    );
  });

  it("warms Pocket without holding Host dispatch behind a fixed delay", () => {
    const dispatchStart = mainSource.indexOf("async function dispatchCapturedTranscript");
    const dispatchEnd = mainSource.indexOf("async function startHeldCapture", dispatchStart);
    const dispatch = mainSource.slice(dispatchStart, dispatchEnd);
    const prepare = dispatch.indexOf("prepareNativeSpeech()");
    const dispatchStartMarker = dispatch.indexOf("speech-dispatch-start");
    const submit = dispatch.indexOf("submitTranscriptToHost");

    assert.isAtLeast(dispatchStart, 0);
    assert.isAtLeast(prepare, 0);
    assert.isAtLeast(dispatchStartMarker, 0);
    assert.isAbove(submit, dispatchStartMarker);
    assert.notInclude(dispatch, "setTimeout(850)");
    assert.include(dispatch, "speech-prewarm-ready");
  });

  it("starts warming Pocket while the user is still speaking", () => {
    const captureStart = mainSource.indexOf("async function startHeldCapture");
    const captureEnd = mainSource.indexOf("function releaseHeldCapture", captureStart);
    const capture = mainSource.slice(captureStart, captureEnd);
    const prepare = capture.indexOf("prepareNativeSpeech()");
    const microphone = capture.indexOf("startParakeetCapture");

    assert.isAtLeast(prepare, 0);
    assert.isAbove(microphone, prepare);
  });

  it("reserves acknowledgement speech before submitting to Jarvis Host", () => {
    const submitStart = mainSource.indexOf("async function submitTranscriptToHost");
    const submitEnd = mainSource.indexOf("async function readSetup", submitStart);
    const submit = mainSource.slice(submitStart, submitEnd);
    const reserve = submit.indexOf("reserveNativeSpeech()");
    const host = submit.indexOf("submitCompanionTask");
    const commit = submit.indexOf(".commit(", host);
    const clearPending = submit.indexOf('if (result.kind !== "error")', host);

    assert.isAtLeast(reserve, 0);
    assert.isAbove(host, reserve);
    assert.isAbove(commit, host);
    assert.isAbove(clearPending, commit);
  });

  it("skips a stale acknowledgement when Pocket is still cold after Host acceptance", () => {
    const dispatchStart = mainSource.indexOf("async function dispatchCapturedTranscript");
    const dispatchEnd = mainSource.indexOf("async function startHeldCapture", dispatchStart);
    const dispatch = mainSource.slice(dispatchStart, dispatchEnd);
    const submitStart = mainSource.indexOf("async function submitTranscriptToHost");
    const submitEnd = mainSource.indexOf("async function readSetup", submitStart);
    const submit = mainSource.slice(submitStart, submitEnd);

    assert.include(dispatch, "isNativeSpeechReady");
    assert.notInclude(dispatch, "let acknowledgementReady");
    assert.include(submit, "acknowledgementReady: () => boolean = isNativeSpeechReady");
    assert.include(submit, "acknowledgementReady()");
  });

  it("loads both native models from the packaged artifact before release", () => {
    assert.include(mainSource, 'process.argv.includes("--speech-smoke")');
    assert.include(mainSource, "prepareNativeMicrophone");
    assert.include(mainSource, "prepareParakeetRecognition(parakeetPaths().paths)");
    assert.include(mainSource, "prepareNativeSpeech()");
    assert.include(
      packageSource,
      '"sherpa-onnx-win-x64": "1.13.6"',
      "Electron Builder needs the platform package as a direct dependency under pnpm.",
    );
    assert.include(releaseWorkflowSource, '"--startup-smoke"');
    assert.include(releaseWorkflowSource, "Invoke-CompanionLifecycleProcess");
    assert.include(releaseWorkflowSource, "$process.WaitForExit($TimeoutMilliseconds)");
    assert.include(releaseWorkflowSource, "$process.ExitCode -ne 0");
    assert.include(releaseWorkflowSource, "Stop-Process -Id $process.Id");
    assert.include(releaseWorkflowSource, "-TimeoutMilliseconds 120000");
    assert.include(releaseWorkflowSource, "-TimeoutMilliseconds 300000");
    assert.notInclude(releaseWorkflowSource, "Start-Process -Wait");
    assert.notInclude(
      releaseWorkflowSource,
      '& "apps/companion/dist/win-unpacked/Jarvis Companion.exe" --speech-smoke',
      "PowerShell does not wait for a GUI executable when it is invoked directly.",
    );
  });

  it("runs the production voice path during packaged speech smoke", () => {
    const smokeStart = mainSource.indexOf("if (packagedSpeechSmoke)");
    const prepareMicrophone = mainSource.indexOf("prepareNativeMicrophone()", smokeStart);
    const prepareRecognition = mainSource.indexOf(
      "prepareParakeetRecognition(parakeetPaths().paths)",
      smokeStart,
    );
    const prepare = mainSource.indexOf("prepareNativeSpeech()", smokeStart);
    const speak = mainSource.indexOf(
      'await speakCompanionSpeech("Jarvis Companion voice is ready.");',
      smokeStart,
    );
    const dispose = mainSource.indexOf("await disposeNativeSpeech()", speak);
    assert.isAtLeast(smokeStart, 0);
    assert.isAbove(prepareMicrophone, smokeStart);
    assert.isAbove(prepareRecognition, prepareMicrophone);
    assert.isAbove(prepare, smokeStart);
    assert.isAbove(prepare, prepareMicrophone);
    assert.isAbove(speak, prepare);
    assert.isAbove(dispose, speak);
  });

  it("surfaces structured Test voice failures in the setup UI", () => {
    const testVoiceHandler = mainSource.indexOf('ipcMain.handle("jarvis-companion:test-voice"');
    const handlerEnd = mainSource.indexOf("  });", testVoiceHandler);
    const handler = mainSource.slice(testVoiceHandler, handlerEnd);
    assert.include(handler, "catch (cause)");
    assert.include(handler, "ok: false");
    assert.include(handler, "companionSpeechFailureMessage(cause)");
    assert.include(mainSource, "if(!result||result.ok!==true)");
    assert.include(mainSource, "result&&result.message");
    assert.include(mainSource, "catch(error)");
  });

  it("requires the installed NSIS executable to pass the speech smoke", () => {
    assert.include(releaseWorkflowSource, "Jarvis-Companion-$version-x64.exe");
    assert.include(releaseWorkflowSource, "-ArgumentList @('/S', $installArgument)");
    assert.include(releaseWorkflowSource, "$installArgument = '/D=' + $installRoot");
    assert.include(releaseWorkflowSource, '"--speech-smoke"');
    assert.include(releaseWorkflowSource, '"--startup-smoke"');
    assert.include(
      releaseWorkflowSource,
      "Invoke-CompanionLifecycleProcess -Label 'Installed Companion startup smoke'",
    );
    assert.include(
      releaseWorkflowSource,
      "Invoke-CompanionLifecycleProcess -Label 'Installed Companion speech smoke'",
    );
    assert.include(releaseWorkflowSource, "-FilePath $installedExe");
    assert.notInclude(releaseWorkflowSource, "Start-Process -Wait");
    assert.include(releaseWorkflowSource, 'Join-Path $installRoot "Jarvis Companion.exe"');
    assert.include(
      releaseWorkflowSource,
      'Join-Path $installRoot "Uninstall Jarvis Companion.exe"',
    );
    assert.include(
      releaseWorkflowSource,
      "Remove-Item -LiteralPath $ResolvedInstallRoot -Recurse -Force",
    );
    assert.include(releaseWorkflowSource, "function Remove-CompanionSmokeInstallRoot");
    assert.include(
      releaseWorkflowSource,
      "$deadline = (Get-Date).AddMilliseconds($TimeoutMilliseconds)",
    );
    assert.include(releaseWorkflowSource, "Start-Sleep -Milliseconds");
    assert.include(releaseWorkflowSource, "Timed out removing speech smoke install root");
    assert.include(
      releaseWorkflowSource,
      "$resolvedInstallRoot = [System.IO.Path]::GetFullPath($installRoot)",
    );
    assert.notInclude(releaseWorkflowSource, "Resolve-Path -LiteralPath $installRoot");
    assert.include(
      releaseWorkflowSource,
      "Remove-CompanionSmokeInstallRoot -ResolvedInstallRoot $resolvedInstallRoot -TimeoutMilliseconds 120000",
    );
    assert.notInclude(releaseWorkflowSource, "while ($true)");
  });

  it("keeps packaged startup smoke on the shell-only lifecycle path", () => {
    assert.include(mainSource, 'process.argv.includes("--startup-smoke")');
    const smokeStart = mainSource.indexOf("} else if (packagedStartupSmoke)");
    const smokeEnd = mainSource.indexOf("} else if (", smokeStart + 1);
    const smoke = mainSource.slice(smokeStart, smokeEnd);
    assert.include(smoke, ".whenReady()");
    assert.include(smoke, "startPackagedStartupSmoke()");
    assert.notInclude(smoke, "start()");
    assert.include(smoke, "tray === undefined || tray.isDestroyed()");
    assert.include(smoke, "resolveCompanionStartupProbePath()");
    assert.include(smoke, "writeCompanionStartupReceipt(startupProbePath");
    assert.include(smoke, "COMPANION_STARTUP_SMOKE_READY");
    assert.include(smoke, "app.exit(0)");
    assert.include(smoke, "app.exit(1)");
    const smokeHelperStart = mainSource.indexOf("function startPackagedStartupSmoke");
    const smokeHelperEnd = mainSource.indexOf("\n}\n\nif (packagedSpeechSmoke)", smokeHelperStart);
    const smokeHelper = mainSource.slice(smokeHelperStart, smokeHelperEnd);
    assert.include(smokeHelper, 'createBubble("setup")');
    assert.include(smokeHelper, "new Tray(iconPath)");
    assert.notInclude(smokeHelper, "installVoiceHotkey");
    assert.notInclude(smokeHelper, "connectReportRelay");
    assert.notInclude(smokeHelper, "configureCompanionUpdates");
    const normalStart = mainSource.indexOf("function start()");
    const normalEnd = mainSource.indexOf("\n}\n\n/**", normalStart);
    const normal = mainSource.slice(normalStart, normalEnd);
    assert.include(normal, "connectReportRelay");
    assert.include(normal, "installVoiceHotkey");
    assert.include(normal, "configureCompanionUpdates");
    assert.include(releaseWorkflowSource, "dbus-x11 libasound2-dev xvfb");
    assert.include(releaseWorkflowSource, "xvfb-run --auto-servernum");
    assert.include(releaseWorkflowSource, 'HOME="$smoke_root/home"');
    assert.include(releaseWorkflowSource, 'appimage="${appimages[0]}"');
    assert.include(releaseWorkflowSource, "APPIMAGE_EXTRACT_AND_RUN=1");
    assert.include(releaseWorkflowSource, '"$appimage" --no-sandbox --startup-smoke');
    assert.notInclude(
      releaseWorkflowSource,
      'app="apps/companion/dist/linux-unpacked/jarvis-companion"',
    );
  });

  it("builds both platforms for the core release transaction", () => {
    assert.include(releaseWorkflowSource, "group: jarvis-companion-release-${{ github.ref }}");
    assert.include(releaseWorkflowSource, "cancel-in-progress: false");
    assert.include(releaseWorkflowSource, "name: Build and test Windows companion");
    const windowsSource = releaseWorkflowSource.slice(0, releaseWorkflowSource.indexOf("  linux:"));
    assert.notInclude(windowsSource, "name: Read version\n");
    assert.include(releaseWorkflowSource, "linux:");
    assert.include(releaseWorkflowSource, "runs-on: ubuntu-24.04");
    assert.include(releaseWorkflowSource, "apps/companion/src/linux-packaging.test.ts");
    assert.include(releaseWorkflowSource, "package:linux:ci");
    assert.include(releaseWorkflowSource, "sherpa-onnx-linux-x64");
    assert.include(releaseWorkflowSource, "sherpa-onnx-win-x64");
    assert.include(releaseWorkflowSource, 'native_root="$app_resources/node_modules/node-cpal"');
    assert.include(releaseWorkflowSource, 'test -f "$native_root/bin/linux-x64/index.node"');
    assert.include(
      releaseWorkflowSource,
      'test ! -e "$app_resources/node_modules/@t3tools/jarvis-native-microphone"',
    );
    assert.include(releaseWorkflowSource, "ELECTRON_RUN_AS_NODE=1");
    assert.include(releaseWorkflowSource, "typeof loaded.createStream !== 'function'");
    assert.include(releaseWorkflowSource, "uiohook-napi/prebuilds/linux-x64/uiohook-napi.node");
    assert.include(releaseWorkflowSource, "uiohook-napi/src");
    assert.include(releaseWorkflowSource, "uiohook-napi/libuiohook");
    assert.include(releaseWorkflowSource, "Jarvis-Companion-*-x86_64.AppImage");
    assert.include(
      releaseWorkflowSource,
      "Jarvis-Companion-Linux-${{ steps.companion_version.outputs.version }}",
    );
    assert.include(releaseWorkflowSource, "latest-linux.yml");
    assert.include(releaseWorkflowSource, "workflow_call:");
    assert.include(releaseWorkflowSource, "workflow_dispatch:");
    assert.include(releaseWorkflowSource, "apps/companion/dist/Jarvis-Companion-*-x64.exe");
    assert.include(releaseWorkflowSource, "apps/companion/dist/Jarvis-Companion-*-x86_64.AppImage");
    assert.notInclude(releaseWorkflowSource, "gh release ");
    assert.notInclude(releaseWorkflowSource, "contents: write");
  });

  it("keeps Host report acknowledgement independent of stopping speech", () => {
    assert.include(mainSource, "await speakCompanionSpeech(text.trim());");
    assert.include(mainSource, "interruptNativeSpeech()");
    assert.notInclude(
      mainSource,
      "acknowledgeReport",
      "Companion interruption must not acknowledge Host reports itself.",
    );
    assert.include(
      mainSource,
      'kind: "interrupted"',
      "An explicit stop may change the overlay without touching report ack.",
    );
  });

  it("uses the dedicated Jarvis asset family for the development tray", () => {
    assert.include(mainSource, "resolveCompanionTrayIconPath");
    assert.include(trayIconSource, '"jarvis-universal-1024.png"');
    assert.notInclude(mainSource, "../marketing/public/icon.png");
    assert.include(packageSource, "../../assets/jarvis/jarvis-universal-1024.png");
    assert.notInclude(packageSource, "../marketing/public/icon.png");
  });
});
