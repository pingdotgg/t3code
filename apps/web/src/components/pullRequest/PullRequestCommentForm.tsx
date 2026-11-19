import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import type { RefObject } from "react";

import { m } from "~/i18n/messages";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { WorkItemCommentForm } from "../workItem/WorkItemCommentForm";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { pullRequestReviewKey } from "./pullRequestReviewStore";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

import { changeRequestTermKind } from "./changeRequestTerm";

export function PullRequestCommentForm({
  environmentId,
  active,
  reference,
  detail,
  actionPending,
  textareaRef,
  onCommentAction,
  onCommented,
  onClose,
}: {
  environmentId: EnvironmentId;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  actionPending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const postComment = useAtomCommand(pullRequestEnvironment.comment, {
    reportFailure: false,
  });
  const inlineConfirm = useInlineActionConfirm(pullRequestReviewKey(reference));
  const followUpAction =
    detail.state === "open" &&
    detail.capabilities.actions.includes("close") &&
    detail.viewerPermissions.actions.includes("close")
      ? ("close" as const)
      : detail.state === "closed" &&
          detail.capabilities.actions.includes("reopen") &&
          detail.viewerPermissions.actions.includes("reopen")
        ? ("reopen" as const)
        : null;

  const submit = async (action: "comment" | "close" | "reopen", text: string) => {
    if (action !== "comment") {
      const result = await onCommentAction(text, action);
      if (result.commentPosted) onClose();
      return result.commentPosted;
    }
    const result = await postComment({ environmentId, input: { ...reference, body: text } });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: m(msg("Could not post the comment")) });
      return false;
    }
    onClose();
    onCommented();
    return true;
  };

  return (
    <WorkItemCommentForm<"close" | "reopen">
      environmentId={environmentId}
      projectId={reference.projectId}
      ownerKey={JSON.stringify(["pr-comment", environmentId, reference])}
      active={active}
      textareaRef={textareaRef}
      completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
      label={gt(
        "Comment on this {term, select, mr {merge request} cr {change request} other {pull request}}",
        {
          term: changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest),
        },
      )}
      placeholder={gt("Leave a comment")}
      locked={actionPending}
      onSubmit={submit}
      actions={({ submit: submitAction, disabled, submitting }) =>
        followUpAction === null ? null : (
          <Button
            size="xs"
            variant={followUpAction === "close" ? "destructive-outline" : "secondary"}
            disabled={disabled}
            {...(followUpAction === "close"
              ? inlineConfirm.props("close", () => submitAction("close"))
              : { onClick: () => submitAction("reopen") })}
          >
            {followUpAction === "close" ? (
              <PullRequestGlyph.closed className="size-3.5" />
            ) : (
              <PullRequestGlyph.reopen className="size-3.5" />
            )}
            {followUpAction === "close" ? (
              // The longest label holds the width, so the confirming click lands on the button.
              <span className="inline-grid">
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  <T>Close with comment</T>
                </span>
                <span className="col-start-1 row-start-1">
                  {submitting === "close"
                    ? gt("Closing...")
                    : inlineConfirm.isArmed("close")
                      ? gt("Confirm close?")
                      : gt("Close with comment")}
                </span>
              </span>
            ) : submitting === "reopen" ? (
              gt("Reopening...")
            ) : (
              gt("Reopen with comment")
            )}
          </Button>
        )
      }
    />
  );
}
