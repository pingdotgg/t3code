import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { MessageSquareIcon, SendIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { PullRequestMarkdownField } from "./PullRequestMarkdownField";
import { toastManager } from "../ui/toast";
import { PullRequestGlyph } from "./pullRequestIcons";

export function PullRequestCommentComposer({
  environmentId,
  reference,
  detail,
  actionPending,
  onCommentAction,
  onCommented,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  actionPending: boolean;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [uploadPending, setUploadPending] = useState(false);
  const [submitting, setSubmitting] = useState<"comment" | "close" | "reopen" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const postComment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });
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
    if (trimmed.length === 0 || submitting !== null || actionPending || uploadPending) return;
    setSubmitting(action);
    if (action !== "comment") {
      const result = await onCommentAction(trimmed, action);
      if (result.commentPosted) {
        setBody("");
        setOpen(false);
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
    setOpen(false);
    onCommented();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" disabled={actionPending} className="shrink-0" />}
        aria-label="Comment on pull request"
      >
        <MessageSquareIcon className="size-3.5" />
        Comment
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)]"
        initialFocus={textareaRef}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <PopoverTitle className="text-sm">Comment on pull request</PopoverTitle>
          <PopoverClose
            render={<Button size="icon-xs" variant="ghost" />}
            aria-label="Close comment composer"
          >
            <XIcon className="size-3.5" />
          </PopoverClose>
        </div>
        <div className="space-y-2">
          <PullRequestMarkdownField
            textareaRef={(element) => {
              textareaRef.current = element;
            }}
            environmentId={environmentId}
            onUploadPendingChange={setUploadPending}
            className="[&_textarea]:max-h-64"
            // Locked while posting: the body is cleared on success, which would otherwise throw
            // away a new draft typed while the request was still in flight.
            disabled={submitting !== null || actionPending}
            value={body}
            rows={3}
            placeholder="Leave a comment"
            aria-label="Comment on this pull request"
            onChange={setBody}
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
          <div className="flex flex-wrap justify-end gap-2">
            {followUpAction === null ? null : (
              <Button
                size="xs"
                variant={followUpAction === "close" ? "destructive-outline" : "outline"}
                disabled={
                  body.trim().length === 0 || submitting !== null || actionPending || uploadPending
                }
                onClick={() => void submit(followUpAction)}
              >
                {followUpAction === "close" ? (
                  <PullRequestGlyph.closed className="size-3.5" />
                ) : (
                  <PullRequestGlyph.reopen className="size-3.5" />
                )}
                {submitting === followUpAction
                  ? followUpAction === "close"
                    ? "Closing..."
                    : "Reopening..."
                  : followUpAction === "close"
                    ? "Close with comment"
                    : "Reopen with comment"}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={
                body.trim().length === 0 || submitting !== null || actionPending || uploadPending
              }
              onClick={() => void submit("comment")}
            >
              <SendIcon className="size-3.5" />
              {submitting === "comment" ? "Posting..." : "Comment"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
