import * as Dialog from "../../components/Dialog";
import { useAtomRefresh } from "@effect/atom-react";
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

/** Small row actions stay in place, preserving expanded rows and scroll position. */
export function usePullRequestAction(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const permissions = usePullRequestPermissions(params, pr);
  const run = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const available = (action: PullRequestAction) =>
    pr !== null && !busy && permissions.canWrite && canPerformPullRequestAction(pr, action);
  const perform = async (action: PullRequestAction, updateMethod?: PullRequestUpdateMethod) => {
    if (pending.current || !available(action)) return;
    pending.current = true;
    setBusy(true);
    try {
      const response = await run({
        ...target,
        input: { ...target.input, action, ...(updateMethod ? { updateMethod } : {}) },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      refreshDetail();
      refreshActivity();
    } catch (cause) {
      Dialog.alert(
        "Couldn't update this pull request",
        cause instanceof Error ? cause.message : "Try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
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
