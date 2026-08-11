import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const MODULE_ROOT = NodePath.resolve(import.meta.dirname, "../../modules/t3-voice-audio-session");
const PNPM_ROOT = NodePath.resolve(import.meta.dirname, "../../../../node_modules/.pnpm");

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(MODULE_ROOT, relativePath), "utf8");
}

function expoModulesCore56Root(): string {
  const installation = NodeFS.readdirSync(PNPM_ROOT).find((entry) =>
    entry.startsWith("expo-modules-core@56.0.17_"),
  );
  if (installation === undefined) throw new Error("ExpoModulesCore 56.0.17 is not installed.");
  return NodePath.join(PNPM_ROOT, installation, "node_modules/expo-modules-core");
}

describe("T3VoiceAudioSession native module", () => {
  it("autolinks the same narrow module name on Apple and Android", () => {
    const config: unknown = JSON.parse(read("expo-module.config.json"));

    expect(config).toEqual({
      platforms: ["apple", "android"],
      apple: { modules: ["T3VoiceAudioSessionModule"] },
      android: {
        modules: ["expo.modules.t3voiceaudiosession.T3VoiceAudioSessionModule"],
      },
    });
    expect(read("ios/T3VoiceAudioSessionModule.swift")).toContain('Name("T3VoiceAudioSession")');
    expect(
      read("android/src/main/java/expo/modules/t3voiceaudiosession/T3VoiceAudioSessionModule.kt"),
    ).toContain('Name("T3VoiceAudioSession")');
  });

  it("keeps iOS observer-only while WebRTC owns audio activation", () => {
    const source = read("ios/T3VoiceAudioSessionModule.swift");

    expect(source).toContain("AVAudioSession.interruptionNotification");
    expect(source).toContain("AVAudioSession.routeChangeNotification");
    expect(source).toContain("AVAudioSession.mediaServicesWereResetNotification");
    expect(source).toContain('Function("stop") { (activationToken: Int) in');
    expect(source).toContain("stopSessionOnMainThread(activationToken: activationToken)");
    expect(source).toContain("currentActivationToken == activationToken");
    expect(source).toContain('["kind": kind, "activationToken": activationToken]');
    expect(source.indexOf("currentActivationToken = nil")).toBeLessThan(
      source.indexOf("center.removeObserver(observer)"),
    );
    expect(source).toContain("OnDestroy");
    expect(source).not.toContain("setActive");
    expect(source).not.toContain("setCategory");
    expect(source).not.toContain(".playAndRecord");
    expect(source).not.toContain(".defaultToSpeaker");
  });

  it("uses token-scoped transient Android voice focus without taking over routing mode", () => {
    const source = read(
      "android/src/main/java/expo/modules/t3voiceaudiosession/T3VoiceAudioSessionModule.kt",
    );

    expect(source).toContain("AudioManager.AUDIOFOCUS_GAIN_TRANSIENT");
    expect(source).toContain("AudioAttributes.USAGE_VOICE_COMMUNICATION");
    expect(source).toContain("AudioManager.ACTION_AUDIO_BECOMING_NOISY");
    expect(source).toContain('Function("stop") { activationToken: Int ->');
    expect(source).toContain("stopSession(activationToken)");
    expect(source).toContain("currentActivationToken != activationToken");
    expect(source).toContain('mapOf("kind" to kind, "activationToken" to activationToken)');
    expect(source.indexOf("currentActivationToken = null")).toBeLessThan(
      source.indexOf("context.unregisterReceiver(receiver)"),
    );
    expect(source).toContain("OnDestroy");
    expect(source).not.toContain("MODE_IN_COMMUNICATION");
    expect(source).not.toContain("manager.mode");
    expect(source).not.toContain("startForegroundService");
    expect(source).not.toContain("Bluetooth");
    expect(source).not.toContain("setSpeakerphoneOn");
  });

  it("keeps Expo 56 synchronous Functions off the async-only runOnQueue API", () => {
    const source = read("ios/T3VoiceAudioSessionModule.swift");
    const expoRoot = expoModulesCore56Root();
    const packageJson: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(expoRoot, "package.json"), "utf8"),
    );
    const syncSource = NodeFS.readFileSync(
      NodePath.join(expoRoot, "ios/Core/Functions/SyncFunctionDefinition.swift"),
      "utf8",
    );
    const asyncSource = NodeFS.readFileSync(
      NodePath.join(expoRoot, "ios/Core/Functions/AsyncFunctionDefinition.swift"),
      "utf8",
    );

    expect(packageJson).toMatchObject({ version: "56.0.17" });
    expect(source).toContain('Function("start")');
    expect(source).toContain('Function("stop")');
    expect(source).not.toContain(".runOnQueue");
    expect(syncSource).not.toContain("func runOnQueue");
    expect(asyncSource).toContain("func runOnQueue");
  });

  it("declares no permissions or background service in the local module", () => {
    const manifest = read("android/src/main/AndroidManifest.xml");
    const moduleText = NodeFS.readdirSync(MODULE_ROOT, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => {
        const path = NodePath.join(MODULE_ROOT, entry);
        return NodeFS.statSync(path).isFile() ? NodeFS.readFileSync(path, "utf8") : "";
      })
      .join("\n");

    expect(manifest).not.toContain("uses-permission");
    expect(moduleText).not.toContain("FOREGROUND_SERVICE");
    expect(moduleText).not.toContain("BLUETOOTH_CONNECT");
    expect(moduleText).not.toContain("UIBackgroundModes");
  });
});
