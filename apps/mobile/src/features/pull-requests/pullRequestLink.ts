import { Platform, Share } from "react-native";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

interface PullRequestLink {
  readonly url: string;
  readonly title: string;
}

export function copyPullRequestLink(pr: PullRequestLink) {
  copyTextWithHaptic(pr.url, { target: "pull request link" });
}

export function sharePullRequestLink(pr: PullRequestLink) {
  // Android ignores `url`; iOS turns a `message` URL into plain text instead of a link preview.
  Share.share(
    Platform.OS === "ios" ? { url: pr.url, title: pr.title } : { message: pr.url, title: pr.title },
  ).catch((cause: unknown) => console.error("Failed to share pull request link.", cause));
}
