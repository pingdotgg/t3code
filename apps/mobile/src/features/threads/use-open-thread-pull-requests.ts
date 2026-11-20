import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";

import * as Dialog from "../../components/ui/Dialog";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";

/** Called once per thread list so virtualized rows share one stable handler. */
export function useOpenThreadPullRequests() {
  const gt = useGT();
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
          gt(
            "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
            { term: changeRequestTermKind(pr.changeRequest) },
          ),
          gt(
            "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
            {
              term: changeRequestTermKind(pr.changeRequest),
            },
          ),
        );
    });
  };
}
