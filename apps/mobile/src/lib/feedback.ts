import { buildFeedbackIssueUrl } from "@t3tools/shared/feedback";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { tryOpenExternalUrl } from "./openExternalUrl";

export function buildMobileFeedbackIssueUrl(input: {
  readonly appVersion: string;
  readonly platform: string;
}): string {
  return buildFeedbackIssueUrl({
    appVersion: input.appVersion,
    surface: "T3 Code Mobile",
    platform: input.platform,
  });
}

function currentMobilePlatform(): string {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} ${String(Platform.Version)}`;
}

export function openMobileFeedbackIssueForm(): Promise<boolean> {
  return tryOpenExternalUrl(
    buildMobileFeedbackIssueUrl({
      appVersion: Constants.expoConfig?.version ?? "0.0.0",
      platform: currentMobilePlatform(),
    }),
    "feedback",
  );
}
