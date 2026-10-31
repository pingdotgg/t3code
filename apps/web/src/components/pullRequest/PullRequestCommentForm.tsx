import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { useTextFieldSpeech, TextFieldSpeechControls } from "~/speech/useTextFieldSpeech";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestReviewKey } from "./pullRequestReviewStore";
import { useInlineActionConfirm } from "./useInlineActionConfirm";
import { PullRequestSubmitKeyHint } from "./PullRequestSubmitKeyHint";

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
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState<"comment" | "close" | "reopen" | null>(null);
  const speech = useTextFieldSpeech({
    environmentId,
    ownerKey: JSON.stringify(["pr-comment", environmentId, reference]),
    text: body,
    textareaRef,
    onTextChange: setBody,
    disabled: !active || submitting !== null || actionPending,
  });
  const { cancel } = speech;
  const closeSetup = speech.setup.setOpen;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release microphone capture and its setup dialog when the comment form becomes inactive.
  useEffect(() => {
    if (!active) {
      cancel();
      closeSetup(false);
    }
  }, [active, cancel, closeSetup]);
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

  const submit = async (action: "comment" | "close" | "reopen") => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || submitting !== null || actionPending || speech.blocksSubmission)
      return;
    setSubmitting(action);
    if (action !== "comment") {
      const result = await onCommentAction(trimmed, action);
      if (result.commentPosted) {
        setBody("");
        onClose();
      }
      setSubmitting(null);
      return;
    }
    const result = await postComment({
      environmentId,
      input: {
        ...reference,
        body: trimmed,
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(null);
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return;
    }
    setBody("");
    setSubmitting(null);
    onClose();
    onCommented();
  };

  return (
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        // Lock while posting because success clears the draft.
        disabled={submitting !== null || actionPending}
        readOnly={speech.freezesEditor}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label={`Comment on this ${sourceControlClients.get(detail.provider).changeRequest.singular}`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit("comment");
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-1">
          <TextFieldSpeechControls
            speech={speech}
            disabled={submitting !== null || actionPending}
          />
        </div>
        {followUpAction === null ? null : (
          <Button
            size="xs"
            variant={followUpAction === "close" ? "destructive-outline" : "secondary"}
            disabled={
              body.trim().length === 0 ||
              submitting !== null ||
              actionPending ||
              speech.blocksSubmission
            }
            {...(followUpAction === "close"
              ? inlineConfirm.props("close", () => void submit("close"))
              : { onClick: () => void submit("reopen") })}
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
                  Close with comment
                </span>
                <span className="col-start-1 row-start-1">
                  {submitting === "close"
                    ? "Closing..."
                    : inlineConfirm.isArmed("close")
                      ? "Confirm close?"
                      : "Close with comment"}
                </span>
              </span>
            ) : submitting === "reopen" ? (
              "Reopening..."
            ) : (
              "Reopen with comment"
            )}
          </Button>
        )}
        <Button
          size="xs"
          disabled={
            body.trim().length === 0 ||
            submitting !== null ||
            actionPending ||
            speech.blocksSubmission
          }
          onClick={() => void submit("comment")}
        >
          <SendIcon className="size-3.5" />
          {submitting === "comment" ? "Posting..." : "Comment"}
          <PullRequestSubmitKeyHint />
        </Button>
      </div>
    </div>
  );
}
