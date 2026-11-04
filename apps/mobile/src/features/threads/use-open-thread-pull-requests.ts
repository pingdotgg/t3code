import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";

import * as Dialog from "../../components/ui/Dialog";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";

/** Called once per thread list so virtualized rows share one stable handler. */
export function useOpenThreadPullRequests() {
  const navigation = useNavigation();
  const navigateToPullRequest = useNavigateToPullRequest();
  return (thread: EnvironmentThreadShell, pr: ThreadPrPresentation) => {
    if (resolveThreadPrBadgeAction(pr).kind === "list") {
      navigation.navigate("ThreadPullRequests", {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      });
      return;
    }
    void navigateToPullRequest(pr.url, {
      environmentId: String(thread.environmentId),
      projectId: String(thread.projectId),
    }).then((opened) => {
      if (!opened)
        Dialog.alert(
          `Unable to open ${pr.changeRequest.shortLabel}`,
          `The ${pr.changeRequest.singular} could not be opened.`,
        );
    });
  };
}
