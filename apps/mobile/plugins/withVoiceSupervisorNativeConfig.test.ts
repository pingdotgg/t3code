import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const MOBILE_ROOT = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const EXPO_CLI = require.resolve("expo/bin/cli", { paths: [MOBILE_ROOT] });

const { MEDIA_PROJECTION_SERVICE, MICROPHONE_USAGE_DESCRIPTION, REQUIRED_ANDROID_PERMISSIONS } =
  require("./withVoiceSupervisorNativeConfig.cjs") as {
    readonly MEDIA_PROJECTION_SERVICE: string;
    readonly MICROPHONE_USAGE_DESCRIPTION: string;
    readonly REQUIRED_ANDROID_PERMISSIONS: readonly string[];
  };

const CAMERA_USAGE_DESCRIPTION =
  "Allow T3 Code to access your camera so you can scan pairing QR codes.";

const APP_VARIANTS = [
  {
    variant: "development",
    name: "T3 Code Dev",
    bundleIdentifier: "com.t3tools.t3code.dev",
  },
  {
    variant: "preview",
    name: "T3 Code Preview",
    bundleIdentifier: "com.t3tools.t3code.preview",
  },
  {
    variant: "production",
    name: "T3 Code",
    bundleIdentifier: "com.t3tools.t3code",
  },
] as const;

const UNNEEDED_VOICE_PERMISSIONS = [
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_ADMIN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.CAPTURE_AUDIO_OUTPUT",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.READ_PHONE_STATE",
  "android.permission.WAKE_LOCK",
] as const;

interface AndroidElement {
  readonly $?: Readonly<Record<string, string>>;
}

interface IntrospectedExpoConfig {
  readonly name: string;
  readonly plugins: ReadonlyArray<string | readonly [string, Readonly<Record<string, unknown>>]>;
  readonly extra: { readonly appVariant: string };
  readonly ios: { readonly bundleIdentifier: string };
  readonly android: { readonly package: string };
  readonly _internal: {
    readonly modResults: {
      readonly ios: {
        readonly infoPlist: Readonly<Record<string, unknown>>;
      };
      readonly android: {
        readonly manifest: {
          readonly manifest: {
            readonly "uses-permission"?: readonly AndroidElement[];
            readonly application?: ReadonlyArray<{
              readonly service?: readonly AndroidElement[];
            }>;
          };
        };
      };
    };
  };
}

function runIntrospection(variant: (typeof APP_VARIANTS)[number]["variant"]) {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [EXPO_CLI, "config", "--type", "introspect", "--json"],
    {
      cwd: MOBILE_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        APP_VARIANT: variant,
        EXPO_NO_DOTENV: "1",
        T3CODE_IOS_PERSONAL_TEAM: "0",
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  return JSON.parse(output) as IntrospectedExpoConfig;
}

function pluginName(plugin: IntrospectedExpoConfig["plugins"][number]): string {
  return typeof plugin === "string" ? plugin : plugin[0];
}

function pluginOptions(config: IntrospectedExpoConfig, name: string) {
  const plugin = config.plugins.find((candidate) => pluginName(candidate) === name);

  if (plugin == null || typeof plugin === "string") {
    throw new Error(`Expected ${name} to have config options.`);
  }

  return plugin[1];
}

describe("voice supervisor native config", () => {
  it.each(APP_VARIANTS)(
    "keeps $variant audio-only permissions deterministic",
    ({ variant, name, bundleIdentifier }) => {
      const config = runIntrospection(variant);
      const infoPlist = config._internal.modResults.ios.infoPlist;
      const manifest = config._internal.modResults.android.manifest.manifest;
      const permissions = manifest["uses-permission"] ?? [];
      const permissionNames = permissions.map((permission) => permission.$?.["android:name"]);

      expect(config.name).toBe(name);
      expect(config.extra.appVariant).toBe(variant);
      expect(config.ios.bundleIdentifier).toBe(bundleIdentifier);
      expect(config.android.package).toBe(bundleIdentifier);
      expect(infoPlist.NSMicrophoneUsageDescription).toBe(MICROPHONE_USAGE_DESCRIPTION);
      expect(infoPlist.NSCameraUsageDescription).toBe(CAMERA_USAGE_DESCRIPTION);
      expect(
        Array.isArray(infoPlist.UIBackgroundModes) ? infoPlist.UIBackgroundModes : [],
      ).not.toContain("audio");

      const voicePluginIndex = config.plugins.findIndex(
        (plugin) => pluginName(plugin) === "./plugins/withVoiceSupervisorNativeConfig.cjs",
      );
      const cameraPluginIndex = config.plugins.findIndex(
        (plugin) => pluginName(plugin) === "expo-camera",
      );
      const imagePickerPluginIndex = config.plugins.findIndex(
        (plugin) => pluginName(plugin) === "expo-image-picker",
      );

      expect(voicePluginIndex).toBeGreaterThanOrEqual(0);
      expect(voicePluginIndex).toBeLessThan(cameraPluginIndex);
      expect(voicePluginIndex).toBeLessThan(imagePickerPluginIndex);
      expect(pluginOptions(config, "expo-camera")).toMatchObject({
        barcodeScannerEnabled: true,
        microphonePermission: false,
        recordAudioAndroid: false,
      });
      expect(pluginOptions(config, "expo-image-picker")).toMatchObject({
        microphonePermission: false,
        photosPermission: false,
      });

      for (const permission of REQUIRED_ANDROID_PERMISSIONS) {
        expect(permissionNames.filter((name) => name === permission)).toHaveLength(1);
      }
      for (const permission of UNNEEDED_VOICE_PERMISSIONS) {
        expect(permissionNames).not.toContain(permission);
      }

      const recordAudio = permissions.find(
        (permission) => permission.$?.["android:name"] === "android.permission.RECORD_AUDIO",
      );
      expect(recordAudio?.$?.["tools:node"]).toBeUndefined();

      const services = manifest.application?.[0]?.service ?? [];
      const mediaProjectionRemoval = services.filter(
        (service) => service.$?.["android:name"] === MEDIA_PROJECTION_SERVICE,
      );
      expect(mediaProjectionRemoval).toEqual([
        {
          $: {
            "android:name": MEDIA_PROJECTION_SERVICE,
            "tools:node": "remove",
          },
        },
      ]);
      expect(
        services.some((service) =>
          ["mediaProjection", "microphone"].includes(
            service.$?.["android:foregroundServiceType"] ?? "",
          ),
        ),
      ).toBe(false);
    },
  );

  it("pins the WebRTC package and both Jitsi native artifacts", () => {
    const mobilePackage = JSON.parse(
      NodeFS.readFileSync(NodePath.join(MOBILE_ROOT, "package.json"), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const workspace = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const lockfile = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    const patch = NodeFS.readFileSync(
      NodePath.join(REPO_ROOT, "patches/react-native-webrtc@124.0.7.patch"),
      "utf8",
    );
    const webrtcRoot = NodePath.dirname(
      require.resolve("react-native-webrtc/package.json", { paths: [MOBILE_ROOT] }),
    );
    const androidBuild = NodeFS.readFileSync(
      NodePath.join(webrtcRoot, "android/build.gradle"),
      "utf8",
    );
    const iosPodspec = NodeFS.readFileSync(
      NodePath.join(webrtcRoot, "react-native-webrtc.podspec"),
      "utf8",
    );

    expect(mobilePackage.dependencies["react-native-webrtc"]).toBe("124.0.7");
    expect(mobilePackage.dependencies["@config-plugins/react-native-webrtc"]).toBeUndefined();
    expect(workspace).toContain(
      "react-native-webrtc@124.0.7: patches/react-native-webrtc@124.0.7.patch",
    );
    expect(lockfile).toMatch(/react-native-webrtc@124\.0\.7: [a-f0-9]{64}/u);
    expect(lockfile).toContain("react-native-webrtc@124.0.7(patch_hash=");
    expect(patch).toContain("+    api 'org.jitsi:webrtc:124.0.0'");
    expect(patch).toContain("+  s.dependency          'JitsiWebRTC', '= 124.0.2'");
    expect(androidBuild).toContain("api 'org.jitsi:webrtc:124.0.0'");
    expect(androidBuild).not.toContain("api 'org.jitsi:webrtc:124.+'");
    expect(iosPodspec).toContain("s.dependency          'JitsiWebRTC', '= 124.0.2'");
    expect(iosPodspec).not.toContain("s.dependency          'JitsiWebRTC', '~> 124.0.0'");
  });
});
