import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { Platform } from "react-native";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  return {
    label: "T3 Code Mobile",
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
