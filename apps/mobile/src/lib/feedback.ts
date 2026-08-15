import { buildFeedbackIssueUrl, type FeedbackType } from "@t3tools/shared/feedback";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { tryOpenExternalUrl } from "./openExternalUrl";

export function buildMobileFeedbackIssueUrl(input: {
  readonly appVersion: string;
  readonly platform: string;
  readonly feedbackType: FeedbackType;
}): string {
  return buildFeedbackIssueUrl(
    {
      appVersion: input.appVersion,
      surface: "T3 Code Mobile",
      platform: input.platform,
    },
    input.feedbackType,
  );
}

function currentMobilePlatform(): string {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} ${String(Platform.Version)}`;
}

export function openMobileFeedbackIssueForm(feedbackType: FeedbackType): Promise<boolean> {
  return tryOpenExternalUrl(
    buildMobileFeedbackIssueUrl({
      appVersion: Constants.expoConfig?.version ?? "0.0.0",
      platform: currentMobilePlatform(),
      feedbackType,
    }),
    "feedback",
  );
}

export async function openMobileFeedbackFromDraft(
  feedbackType: FeedbackType,
  clearDraft: () => void,
  openIssueForm: (type: FeedbackType) => Promise<boolean> = openMobileFeedbackIssueForm,
): Promise<boolean> {
  const opened = await openIssueForm(feedbackType);
  if (opened) {
    clearDraft();
  }
  return opened;
}
