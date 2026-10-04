import type { ExpoConfig } from "expo/config";
const config: ExpoConfig = {
  name: "T3 Mobile", slug: "t3mobile", version: "0.1.0", scheme: "t3mobile",
  platforms: ["android"], userInterfaceStyle: "automatic",
  android: {
    package: "com.screengd.t3mobile",
    adaptiveIcon: { foregroundImage: "./assets/android-icon-foreground.png", backgroundColor: "#18181b" },
  },
  plugins: [
    "expo-dev-client", "expo-secure-store",
    "expo-font",
    ["expo-build-properties", { android: { minSdkVersion: 29 } }],
    "./plugins/withAndroidCleartextTraffic.cjs",
  ],
};
export default config;
