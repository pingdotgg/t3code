import type { ExpoConfig } from "expo/config";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);
// Expo's TypeScript setup otherwise installs `typescript` on every start; we typecheck with tsrs.
process.env.EXPO_NO_TYPESCRIPT_SETUP = "1";

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

// Fork identity for builds on a team other than T3 Tools. T3CODE_IOS_PERSONAL_TEAM only
// controls capability stripping; the PERSONAL_TEAM-suffixed names stay accepted.
const iosBundleIdentifierOverride = (
  repoEnv.T3CODE_IOS_BUNDLE_ID ?? repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID
)?.trim();
const appNameOverride = repoEnv.T3CODE_APP_NAME?.trim();
// Path to a 1024x1024 PNG, relative to the repository root.
const appIconOverride = repoEnv.T3CODE_APP_ICON?.trim() || "assets/pseudocode/app-icon-1024.png";
// App Store Connect rejects a reused build number, so fork TestFlight uploads set this.
const iosBuildNumberOverride = repoEnv.T3CODE_IOS_BUILD_NUMBER?.trim();
// Optional: Xcode's automatic signing picks the sole available team when unset.
const iosTeamIdOverride = (
  repoEnv.T3CODE_IOS_TEAM_ID ?? repoEnv.T3CODE_IOS_PERSONAL_TEAM_ID
)?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!iosBundleIdentifierOverride || !IOS_BUNDLE_IDENTIFIER_PATTERN.test(iosBundleIdentifierOverride))
) {
  throw new Error(
    "T3CODE_IOS_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

if (
  iosBundleIdentifierOverride &&
  !IOS_BUNDLE_IDENTIFIER_PATTERN.test(iosBundleIdentifierOverride)
) {
  throw new Error(
    "T3CODE_IOS_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#347FF8",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-dev.png",
  androidSplashIcon: "./assets/android-splash-icon-dev.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111533",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-nightly.png",
  androidSplashIcon: "./assets/android-splash-icon-nightly.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#000000",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: "./assets/android-splash-icon-prod.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "PseudoCode Dev",
    scheme: "t3code-dev",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "PseudoCode Preview",
    scheme: "t3code-preview",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "PseudoCode",
    scheme: "t3code",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    case undefined:
      return "production";
    default:
      throw new Error("APP_VARIANT must be development, preview, or production.");
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = iosBundleIdentifierOverride ?? variant.iosBundleIdentifier;
const overriddenAppIcon = fromRepoRoot(appIconOverride);

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const mesloFonts = {
  regular: "./assets/fonts/MesloLGS-NF-Regular.ttf",
  bold: "./assets/fonts/MesloLGS-NF-Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "PseudoCodeOverview",
        displayName: "PseudoCode Overview",
        description: "See active work, recent threads, and results ready to review.",
        android: null,
        ios: {
          configuration: {
            title: "PseudoCode Overview",
            description: "Choose what this widget shows.",
            parameters: {
              view: {
                title: "View",
                type: "enum",
                default: "overview",
                values: [
                  { name: "Overview", value: "overview" },
                  { name: "Active now", value: "active" },
                  { name: "Recent threads", value: "recent" },
                  { name: "Ready to review", value: "review" },
                ],
              },
            },
          },
          supportedFamilies: ["systemSmall", "systemMedium", "systemLarge", "systemExtraLarge"],
          initialLayout: "./src/widgets/pseudocode/OverviewWidget.tsx",
        },
      },
      {
        name: "SubscriptionUsage",
        displayName: "Subscription usage",
        description: "Subscription quotas from your connected PseudoCode environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          minResizeWidth: 180,
          minResizeHeight: 130,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // The embedded layout renders before first launch; publishing replaces it with stored props.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "PseudoCode",
        description: "Follow your tasks, answer requests, and review recent results.",
        android: null,
        ios: {
          supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
          // Embeds the layout so the gallery preview and a new widget render
          // before the app has run once; the app replaces it on publish.
          initialLayout: "./src/widgets/AgentActivityWidget.tsx",
        },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  name: appNameOverride ?? variant.appName,
  slug: "t3-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.4.0",
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: overriddenAppIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: false,
  },
  ios: {
    icon: overriddenAppIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    ...(iosBuildNumberOverride ? { buildNumber: iosBuildNumberOverride } : {}),
    // Avoid Personal Team fallback: it cannot sign App Groups, Apple sign-in or push entitlements.
    // A Personal Team build signs with its own team, or leaves the choice to automatic signing.
    ...(iosTeamIdOverride
      ? { appleTeamId: iosTeamIdOverride }
      : isIosPersonalTeamBuild
        ? {}
        : { appleTeamId: "ARK85ZXQ4Z" }),
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${variant.iosBundleIdentifier}`],
      ...(isIosPersonalTeamBuild
        ? {}
        : { "aps-environment": APP_VARIANT === "development" ? "development" : "production" }),
    },
    infoPlist: {
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow PseudoCode to connect to PseudoCode servers on your local network or tailnet.",
      // Built with the iOS 27 SDK, only view controllers can hide or style the status bar.
      UIViewControllerBasedStatusBarAppearance: true,
      NSPhotoLibraryAddUsageDescription: "Allow PseudoCode to save images to your photo library.",
      // System picture in picture needs background audio to start and survive outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: overriddenAppIcon,
    package: variant.androidPackage,
    ...(repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE
      ? { googleServicesFile: repoEnv.T3CODE_ANDROID_GOOGLE_SERVICES_FILE }
      : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: overriddenAppIcon,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: overriddenAppIcon,
  },
  plugins: [
    // First on purpose: same-type mods run last-registered-first, so its entitlements mod runs
    // after expo-notifications and Clerk have written aps-environment and sign-in.
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
    "expo-asset",
    [
      "expo-font",
      {
        ios: {
          fonts: [
            dmSansFonts.regular,
            dmSansFonts.medium,
            dmSansFonts.bold,
            mesloFonts.regular,
            mesloFonts.bold,
          ],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              // Android picks fallback glyphs (such as Vietnamese) at the requested weight, so bold text
              // asks for 700; the 400 entry lets a relative bold step (Typeface.BOLD) land on 700 too.
              fontDefinitions: [
                { path: dmSansFonts.bold, weight: 400 },
                { path: dmSansFonts.bold, weight: 700 },
              ],
            },
            {
              // One family for both weights, as on iOS, so fontWeight picks the bold file.
              fontFamily: "MesloLGS-NF-Regular",
              fontDefinitions: [
                { path: mesloFonts.regular, weight: 400 },
                { path: mesloFonts.bold, weight: 700 },
              ],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        // Direct push sends silent widget refreshes; a Personal Team cannot sign push at all.
        enableRemoteNotifications: !isIosPersonalTeamBuild,
        enableBackgroundRemoteNotifications: !isIosPersonalTeamBuild,
      },
    ],
    // Gate Clerk here: its plugin also writes native sign-in config the entitlement stripper leaves behind.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: overriddenAppIcon,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow PseudoCode to use your microphone for voice input.",
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow PseudoCode to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: false,
        // `false` makes this plugin add RECORD_AUDIO to blockedPermissions, breaking Android dictation.
        microphonePermission: "Allow PseudoCode to use your microphone for voice input.",
      },
    ],
    [
      "expo-splash-screen",
      {
        image: overriddenAppIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: overriddenAppIcon,
          backgroundColor: "#0a0a0a",
        },
        android: {
          // Android 12+ masks the central two thirds of the 288dp canvas; adaptive layers avoid clipped corners.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    "./plugins/withDictationPods.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    // MainActivity mods run in reverse order; extend the tablet-orientation override.
    "./plugins/withAndroidWindowDisplayMetrics.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
  },
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
