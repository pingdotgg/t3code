import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { currentChangeRequestTerms } from "@t3tools/client-runtime/source-control-clients";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { canPerformPullRequestAction, pullRequestActionLabel } from "./pullRequestActions";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

export function usePullRequestAction(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const permissions = usePullRequestPermissions(params, pr);
  const run = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const available = (action: PullRequestAction) =>
    pr !== null && !busy && permissions.canWrite && canPerformPullRequestAction(pr, action);
  const perform = async (action: PullRequestAction, updateMethod?: PullRequestUpdateMethod) => {
    if (pending.current || !available(action)) return;
    pending.current = true;
    setBusy(true);
    const response = await run({
      ...target,
      input: { ...target.input, action, ...(updateMethod ? { updateMethod } : {}) },
    });
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        `Couldn't update this ${currentChangeRequestTerms().singular}`,
        cause instanceof Error ? cause.message : "Try again.",
      );
      return;
    }
    refreshActivity();
  };
  const confirm = (action: PullRequestAction, title: string, message: string) =>
    Dialog.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: title,
        style: action === "close" || action === "delete-branch" ? "destructive" : "default",
        onPress: () => void perform(action),
      },
    ]);
  const confirmClose = () => {
    const terminology = currentChangeRequestTerms();
    confirm(
      "close",
      pullRequestActionLabel("close", terminology),
      `Close this ${terminology.singular} without merging its changes?`,
    );
  };
  return { available, perform, confirm, confirmClose, busy };
}
