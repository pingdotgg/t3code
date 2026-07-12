import type { ExpoConfig } from "expo/config";

import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);

// All variants use the plain SurgeCode ./assets/icon.png (see
// scripts/generate-appicon.swift). assets/icon-composer-{dev,prod}.icon are
// stale upstream Icon Composer bundles (still carrying the old T3 mark,
// Assets/T3.svg) — no longer referenced from this config, left in place
// rather than hand-authoring new .icon bundles.
const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosIcon: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
    readonly relyingParty?: string;
  }
> = {
  development: {
    appName: "SurgeCode Dev",
    scheme: "surgecode-dev",
    iosIcon: "./assets/icon.png",
    iosBundleIdentifier: "com.sergeserb.sergecode.dev",
    androidPackage: "com.sergeserb.sergecode.dev",
    relyingParty: "clerk.t3.codes",
  },
  preview: {
    appName: "SurgeCode Preview",
    scheme: "surgecode-preview",
    iosIcon: "./assets/icon.png",
    iosBundleIdentifier: "com.sergeserb.sergecode.preview",
    androidPackage: "com.sergeserb.sergecode.preview",
    relyingParty: "clerk.t3.codes",
  },
  production: {
    appName: "SurgeCode",
    scheme: "surgecode",
    iosIcon: "./assets/icon.png",
    iosBundleIdentifier: "com.sergeserb.sergecode",
    androidPackage: "com.sergeserb.sergecode",
    relyingParty: "clerk.t3.codes",
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

// Free-Apple-ID device builds: sign with the developer's Personal Team
// instead of the pinned T3 Tools team. Personal teams cannot sign app
// groups, push, or associated domains, and cannot claim another team's
// bundle identifier — so this drops the widgets extension and associated
// domains and uses a team-derived bundle id. Local development installs
// only; hosted (EAS) and non-development builds refuse the flag outright.
const personalSigning = process.env.SERGECODE_PERSONAL_SIGNING === "1";
if (personalSigning && (process.env.EAS_BUILD === "true" || process.env.EAS_BUILD_PROFILE)) {
  throw new Error(
    "SERGECODE_PERSONAL_SIGNING is for local device installs and must never reach an EAS build.",
  );
}
if (personalSigning && APP_VARIANT !== "development") {
  throw new Error(
    `SERGECODE_PERSONAL_SIGNING only supports APP_VARIANT=development (got "${APP_VARIANT}").`,
  );
}
const PERSONAL_TEAM_ID = process.env.SERGECODE_PERSONAL_TEAM_ID;
if (personalSigning && !PERSONAL_TEAM_ID) {
  throw new Error(
    "SERGECODE_PERSONAL_SIGNING requires SERGECODE_PERSONAL_TEAM_ID (your Personal Team ID, " +
      "shown in Xcode → Settings → Accounts).",
  );
}
// Derived from the team id so two developers never collide on one bundle id;
// Apple bundle ids are case-insensitive alphanumerics + dots/hyphens, and
// team ids are already alphanumeric.
const iosBundleIdentifier = personalSigning
  ? (process.env.SERGECODE_PERSONAL_BUNDLE_ID ??
    `dev.${PERSONAL_TEAM_ID!.toLowerCase()}.sergecode.development`)
  : variant.iosBundleIdentifier;

const config: ExpoConfig = {
  name: variant.appName,
  slug: "sergecode",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "0.1.0",
  runtimeVersion: {
    policy: process.env.MOBILE_VERSION_POLICY ?? "appVersion",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  // Upstream EAS project leftovers (T3 Tools' expo.dev project). SergeCode
  // does not run hosted EAS updates/builds; local personal-signed builds
  // never contact this URL/project. Left in place rather than pointed at a
  // new EAS project — do not create or contact one.
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
    // Pin code signing to the T3 Tools team so non-interactive `expo run:ios`
    // does not fall back to a personal team (which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements).
    appleTeamId: personalSigning ? PERSONAL_TEAM_ID! : "ARK85ZXQ4Z",
    // relyingParty (clerk.t3.codes) is an upstream T3 Tools leftover, unused
    // by local personal-signed builds (which drop associatedDomains below).
    ...(personalSigning
      ? {}
      : {
          associatedDomains: [
            `applinks:${variant.relyingParty}`,
            `webcredentials:${variant.relyingParty}`,
          ],
        }),
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow SurgeCode to connect to SurgeCode servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    icon: "./assets/icon.png",
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#DCE9E0",
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
    // Expo entitlement mods compose LIFO (each plugin wraps the previous),
    // so registering this FIRST makes it run LAST — after Clerk & co. have
    // added the entitlements a Personal Team cannot sign.
    ...(personalSigning ? ["./plugins/withPersonalTeamEntitlements.cjs"] : []),
    "expo-font",
    "expo-secure-store",
    ["@clerk/expo", { theme: "./clerk-theme.json" }],
    "expo-web-browser",
    [
      "expo-camera",
      {
        cameraPermission: "Allow SurgeCode to access your camera so you can scan pairing QR codes.",
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        backgroundColor: "#f2f4f0",
        imageWidth: 220,
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: "#0b0d0b",
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
    // Personal-team signing cannot carry the widgets extension (app group +
    // push entitlements); see personalSigning above.
    ...(personalSigning
      ? []
      : [
          [
            "expo-widgets",
            {
              bundleIdentifier: `${variant.iosBundleIdentifier}.widgets`,
              groupIdentifier: `group.${variant.iosBundleIdentifier}`,
              enablePushNotifications: true,
              widgets: [
                {
                  name: "AgentActivity",
                  displayName: "Agent Activity",
                  description: "Shows the current state of active SurgeCode agents.",
                  supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
                },
              ],
            },
          ] as const,
        ]),
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withIosPodDeploymentFloor.cjs",
  ] as ExpoConfig["plugins"],
  extra: {
    appVariant: APP_VARIANT,
    relay: {
      url: repoEnv.T3CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    unsplash: {
      // Public read-only access key for Dolomites scenery. Delivered at
      // build time (root .env.local locally, EAS env in CI) — never
      // committed. Absent key = gradient washes everywhere.
      accessKey: repoEnv.EXPO_PUBLIC_UNSPLASH_ACCESS_KEY ?? null,
    },
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    // eas.projectId and owner (below) are the upstream T3 Tools EAS project
    // — upstream leftovers unused by local personal-signed builds. Do not
    // create or contact a SergeCode EAS project.
    eas: {
      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
    },
  },
  owner: "pingdotgg",
};

export default config;
