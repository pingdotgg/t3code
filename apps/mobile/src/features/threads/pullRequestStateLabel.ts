import { translate } from "@t3tools/i18n";

export function pullRequestStateLabel(state: string) {
  switch (state.toLowerCase()) {
    case "open":
      return translate("common:mobileUiPullRequestOpen", "Open");
    case "closed":
      return translate("common:mobileUiPullRequestClosed", "Closed");
    case "merged":
      return translate("common:mobileUiPullRequestMerged", "Merged");
    default:
      return state;
  }
}
