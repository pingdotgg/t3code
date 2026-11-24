import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  createTaskListSaveQueue,
  settleTaskListDraft,
  startTaskListToggle,
  taskListDraftInForce,
  type TaskListDraft,
} from "@t3tools/client-runtime/pull-request-editing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";
import type { PullRequestComment } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

/**
 * A comment body with task ticks shown at once and saved in tap order. `updateComment` refreshes
 * the activity after each save, which brings the host's copy back.
 */
export function usePullRequestCommentTasks(
  params: PullRequestParams,
  comment: Pick<PullRequestComment, "id" | "body" | "kind">,
  canEdit: boolean,
) {
  const gt = useGT();
  const updateComment = useAtomCommand(composerPullRequests.updateComment, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<TaskListDraft | null>(null);
  const [enqueue] = useState(createTaskListSaveQueue);
  const kept = taskListDraftInForce(draft, comment.body);
  if (kept !== draft) setDraft(kept);
  const body = kept?.body ?? comment.body;
  const save = async (next: string) => {
    if (comment.kind === "review") return false;
    const target = pullRequestTarget(params);
    const result = await updateComment({
      ...target,
      input: { ...target.input, commentId: comment.id, kind: comment.kind, body: next },
    });
    if (!AsyncResult.isFailure(result)) return true;
    const cause = squashAtomCommandFailure(result);
    Dialog.alert(
      gt("Could not save the comment"),
      cause instanceof Error ? (errorDisplayMessage(cause, m) ?? cause.message) : gt("Try again."),
    );
    return false;
  };
  return {
    body,
    toggleTask: canEdit
      ? ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
          const next = setMarkdownTaskChecked(body, markerOffset, checked);
          if (next === body) return false;
          setDraft(startTaskListToggle(kept, comment.body, next));
          enqueue(() => save(next), {
            failed: () => setDraft(null),
            drained: () => setDraft(settleTaskListDraft),
          });
          return true;
        }
      : undefined,
  };
}
