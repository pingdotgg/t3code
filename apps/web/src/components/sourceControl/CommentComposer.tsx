import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CircleCheckIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

type CommentPayload = {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
    readonly body: string;
  };
};

export function CommentComposer({
  environmentId,
  detail,
  label,
  command,
  followUpAction = null,
  actionPending = false,
  onCommentAction,
  onCommented,
}: {
  environmentId: EnvironmentId;
  detail: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
  };
  label: string;
  command: AtomCommand<CommentPayload, unknown, unknown>;
  actionPending?: boolean;
  followUpAction?: "close" | "reopen" | null;
  onCommentAction?: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
}) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState<"comment" | "close" | "reopen" | null>(null);
  const postComment = useAtomCommand(command, { reportFailure: false });
  const submit = async (action: "comment" | "close" | "reopen") => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || submitting !== null || actionPending) return;
    setSubmitting(action);
    if (action !== "comment") {
      if (!onCommentAction) {
        setSubmitting(null);
        return;
      }
      const result = await onCommentAction(trimmed, action);
      if (result.commentPosted) setBody("");
      setSubmitting(null);
      return;
    }
    const result = await postComment({
      environmentId,
      input: {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
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
    onCommented();
  };

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        // Locked while posting: the body is cleared on success, which would otherwise throw
        // away a new draft typed while the request was still in flight.
        disabled={submitting !== null || actionPending}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label={label}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        {followUpAction === null || !onCommentAction ? null : (
          <Button
            size="xs"
            variant={followUpAction === "close" ? "destructive-outline" : "outline"}
            disabled={body.trim().length === 0 || submitting !== null || actionPending}
            onClick={() => void submit(followUpAction)}
          >
            {followUpAction === "close" ? (
              <CircleCheckIcon className="size-3.5" />
            ) : (
              <RotateCcwIcon className="size-3.5" />
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
          disabled={body.trim().length === 0 || submitting !== null || actionPending}
          onClick={() => void submit("comment")}
        >
          <SendIcon className="size-3.5" />
          {submitting === "comment" ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}
