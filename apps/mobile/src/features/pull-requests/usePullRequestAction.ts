import { AsyncResult } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { canPerformPullRequestAction } from "./pullRequestActions";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

export function usePullRequestAction(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const permissions = usePullRequestPermissions(params, pr);
  const run = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const available = (action: PullRequestAction) =>
    pr !== null && !busy && permissions.canWrite && canPerformPullRequestAction(pr, action);
  const perform = async (action: PullRequestAction, updateMethod?: PullRequestUpdateMethod) => {
    if (
      pending.current ||
      !pr ||
      pr.viewerPermissions.deniedActions?.[action] ||
      !available(action)
    )
      return;
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
        "Couldn't update this pull request",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
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
  return { available, perform, confirm, busy };
}
