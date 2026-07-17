import { SHOWCASE_SCENES, type ShowcaseScene } from "./mobile-showcase-environment.ts";

export { SHOWCASE_SCENES };
export type { ShowcaseScene };

export type ShowcaseAppearance = "light" | "dark";

export interface ShowcaseStoreAssetSpec {
  readonly store: "apple" | "google-play";
  /** Device directory relative to ShowcaseConfig.outputDirectory. */
  readonly directory: string;
  readonly width: number;
  readonly height: number;
  readonly minimumUploadCount: number;
  readonly maximumUploadCount: number;
  readonly maximumFileSizeBytes?: number;
}

export interface ShowcaseIosDevice {
  readonly id: string;
  readonly platform: "ios";
  /** Exact name from `xcrun simctl list devices available`. */
  readonly simulator: string;
  /** Device type used to create a disposable simulator when the named one is absent. */
  readonly simulatorDeviceType?: string;
  /** Appearance used when the CLI does not pass --appearance. */
  readonly appearance: ShowcaseAppearance;
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  readonly storeAsset: ShowcaseStoreAssetSpec;
}

export interface ShowcaseAndroidDevice {
  readonly id: string;
  readonly platform: "android";
  /** Exact name from `emulator -list-avds`. */
  readonly avd: string;
  /** Appearance used when the CLI does not pass --appearance. */
  readonly appearance: ShowcaseAppearance;
  /** Native ABI used by the AVD, from its config.ini `abi.type`. */
  readonly abi?: "arm64-v8a" | "x86_64" | "x86" | "armeabi-v7a";
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  /** Optional capture viewport. Omit to use the AVD's native size and density. */
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
    readonly density?: number;
  };
  readonly storeAsset: ShowcaseStoreAssetSpec;
}

export type ShowcaseDevice = ShowcaseIosDevice | ShowcaseAndroidDevice;

export interface ShowcaseConfig {
  readonly outputDirectory: string;
  readonly metroPort: number;
  readonly settleDelayMs: number;
  readonly devices: ReadonlyArray<ShowcaseDevice>;
}

const ANDROID_ABIS = ["arm64-v8a", "x86_64", "x86", "armeabi-v7a"] as const;

export function resolveShowcaseAndroidAbi(
  value: string | undefined,
): NonNullable<ShowcaseAndroidDevice["abi"]> {
  if (!value) return "arm64-v8a";
  if (ANDROID_ABIS.some((abi) => abi === value)) {
    return value as NonNullable<ShowcaseAndroidDevice["abi"]>;
  }
  throw new Error(
    `Unsupported T3_SHOWCASE_ANDROID_ABI '${value}'. Use ${ANDROID_ABIS.join(", ")}.`,
  );
}

/**
 * The defaults cover every App Store Connect and Google Play upload slot used
 * by the mobile app. Edit this matrix (or pass --device / --scene) without
 * changing the runner. Every target declares and validates its exact upload
 * dimensions so SDK or emulator changes cannot silently produce invalid files.
 */
const config: ShowcaseConfig = {
  outputDirectory: "artifacts/app-store/screenshots",
  // Dedicated port so the harness cannot attach to a normal mobile dev server
  // (or a second worktree) and capture the wrong bundle.
  metroPort: 8199,
  settleDelayMs: 2_500,
  devices: [
    {
      id: "iphone-6.9",
      platform: "ios",
      simulator: "iPhone 17 Pro Max",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
      appearance: "dark",
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/iphone-6.9",
        width: 1320,
        height: 2868,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: "iphone-6.5",
      platform: "ios",
      simulator: "T3 Showcase iPhone 14 Plus",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-14-Plus",
      appearance: "dark",
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/iphone-6.5",
        width: 1284,
        height: 2778,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: "ipad-13",
      platform: "ios",
      simulator: "iPad Pro 13-inch (M5)",
      simulatorDeviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-16GB",
      appearance: "dark",
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "apple",
        directory: "apple/ipad-13",
        width: 2064,
        height: 2752,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: "pixel",
      platform: "android",
      avd: "Pixel_10_Pro",
      // Apple Silicon uses ARM64 locally; CI overrides this with x86_64 so its
      // Blacksmith Linux runner can use KVM acceleration.
      abi: resolveShowcaseAndroidAbi(process.env.T3_SHOWCASE_ANDROID_ABI),
      appearance: "dark",
      viewport: {
        width: 1080,
        height: 1920,
        density: 420,
      },
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "google-play",
        directory: "google-play/phone",
        width: 1080,
        height: 1920,
        minimumUploadCount: 2,
        maximumUploadCount: 8,
        maximumFileSizeBytes: 8 * 1024 * 1024,
      },
    },
    {
      id: "android-tablet-7",
      platform: "android",
      avd: "Pixel_10_Pro",
      abi: resolveShowcaseAndroidAbi(process.env.T3_SHOWCASE_ANDROID_ABI),
      appearance: "dark",
      viewport: {
        width: 1080,
        height: 1920,
        density: 288,
      },
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "google-play",
        directory: "google-play/tablet-7",
        width: 1080,
        height: 1920,
        minimumUploadCount: 4,
        maximumUploadCount: 8,
        maximumFileSizeBytes: 8 * 1024 * 1024,
      },
    },
    {
      id: "android-tablet-10",
      platform: "android",
      avd: "Pixel_10_Pro",
      abi: resolveShowcaseAndroidAbi(process.env.T3_SHOWCASE_ANDROID_ABI),
      appearance: "dark",
      viewport: {
        width: 1440,
        height: 2560,
        density: 288,
      },
      scenes: ["thread", "terminal", "review", "threads", "environments"],
      storeAsset: {
        store: "google-play",
        directory: "google-play/tablet-10",
        width: 1440,
        height: 2560,
        minimumUploadCount: 4,
        maximumUploadCount: 8,
        maximumFileSizeBytes: 8 * 1024 * 1024,
      },
    },
  ],
};

export default config;
