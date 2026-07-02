import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosIcon: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
  }
> = {
  development: {
    appName: "T3 Code Dev",
    scheme: "t3code-dev",
    iosIcon: "./assets/icon-composer-dev.icon",
    iosBundleIdentifier: "com.t3tools.t3code.dev",
    androidPackage: "com.t3tools.t3code.dev",
  },
  preview: {
    appName: "T3 Code Preview",
    scheme: "t3code-preview",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.t3tools.t3code.preview",
    androidPackage: "com.t3tools.t3code.preview",
  },
  production: {
    appName: "T3 Code",
    scheme: "t3code",
    iosIcon: "./assets/icon-composer-prod.icon",
    iosBundleIdentifier: "com.t3tools.t3code",
    androidPackage: "com.t3tools.t3code",
  },
};

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier =
  isIosPersonalTeamBuild && personalTeamBundleIdentifier
    ? personalTeamBundleIdentifier
    : variant.iosBundleIdentifier;

const widgetsPlugin = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    widgets: [
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active T3 Code agents.",
        supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
      },
    ],
  },
] satisfies NonNullable<ExpoConfig["plugins"]>[number];

const config: ExpoConfig = {
  name: variant.appName,
  slug: "t3-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "0.1.0",
  runtimeVersion: {
    policy: process.env.MOBILE_VERSION_POLICY ?? "appVersion",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  updates: {
    enabled: true,
    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.iosIcon,
    supportsTablet: true,
    bundleIdentifier: iosBundleIdentifier,
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: "./assets/icon.png",
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-asset",
    "expo-font",
    "expo-secure-store",
    // appleSignIn must be gated here: withoutIosPersonalTeamCapabilities.cjs runs before
    // plugins earlier in this array, so it cannot strip the entitlement Clerk would add.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-camera",
      {
        cameraPermission: "Allow T3 Code to access your camera so you can scan pairing QR codes.",
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
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
    ...(!isIosPersonalTeamBuild ? [widgetsPlugin] : []),
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
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
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    eas: {
      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    },
  },
  owner: "pingdotgg",
};

export default config;
