import { usePullRequestDeniedActions } from "./PullRequestReviewContext";
import { PullRequestPermissionButton } from "./PullRequestPermissionButton";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { MessageSquareReplyIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { PullRequestTextarea as Textarea } from "./PullRequestTextarea";

export function PullRequestDiscussionReplyForm(props: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadId: string;
  canResolve?: boolean;
  onReplied: () => void;
}) {
  return (
    <ReplyComposer
      key={`${props.environmentId}:${props.reference.projectId}:${props.reference.host}:${props.reference.repository}:${props.reference.number}:${props.threadId}`}
      {...props}
    />
  );
}

function ReplyComposer({
  environmentId,
  reference,
  threadId,
  canResolve = false,
  onReplied,
}: Parameters<typeof PullRequestDiscussionReplyForm>[0]) {
  const denied = usePullRequestDeniedActions();
  const allowed = useAtomValue(pullRequestEnvironment.replyToThread.permissionAtom(environmentId));
  const resolutionAllowed = useAtomValue(
    pullRequestEnvironment.setThreadResolution.permissionAtom(environmentId),
  );
  const resolve = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const reply = useAtomCommand(pullRequestEnvironment.replyToThread, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const resolvable = canResolve && resolutionAllowed && !denied.resolve;
  // Read after the reply posts: the discussion may have closed, or access changed, meanwhile.
  const stillResolvable = useRef(resolvable);
  useEffect(() => {
    stillResolvable.current = resolvable;
  });
  const submit = async (resolveAfter = false) => {
    const text = body.trim();
    if (!allowed || denied.comment || (resolveAfter && !resolvable) || pending.current || !text)
      return;
    pending.current = true;
    setPosting(true);
    setError(null);
    await Promise.resolve()
      .then(() => reply({ environmentId, input: { ...reference, threadId, body: text } }))
      .then(async (result) => {
        if (result._tag === "Failure") {
          setError("Could not post the reply. Your draft is still here; try again.");
          return;
        }
        setBody("");
        if (resolveAfter && stillResolvable.current) {
          const resolution = await resolve({
            environmentId,
            input: { ...reference, threadId, resolved: true },
          });
          if (resolution._tag === "Failure") {
            setError(
              "Your reply was posted, but the discussion could not be resolved. Use its status control to retry.",
            );
            onReplied();
            return;
          }
        }
        setOpen(false);
        onReplied();
      })
      .finally(() => {
        pending.current = false;
        setPosting(false);
      });
  };
  if (!open)
    return (
      <PullRequestPermissionButton
        reason={denied.comment}
        size="xs"
        variant="ghost-muted"
        aria-label="Reply to this discussion"
        disabled={!allowed}
        onClick={() => setOpen(true)}
      >
        <MessageSquareReplyIcon className="size-3.5" /> Reply
      </PullRequestPermissionButton>
    );
  return (
    <div className="space-y-2">
      <Textarea
        autoFocus
        aria-label="Reply to this discussion"
        placeholder="Write a reply…"
        maxLength={65536}
        rows={3}
        disabled={posting || !allowed}
        value={body}
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
            if (!event.repeat) void submit();
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost-muted" disabled={posting} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {canResolve && resolutionAllowed ? (
          <PullRequestPermissionButton
            reason={denied.comment ?? denied.resolve}
            size="xs"
            variant="outline"
            disabled={posting || !allowed || !body.trim()}
            onClick={() => void submit(true)}
          >
            Reply &amp; resolve
          </PullRequestPermissionButton>
        ) : null}
        <PullRequestPermissionButton
          reason={denied.comment}
          size="xs"
          variant="outline"
          aria-label="Post reply"
          disabled={posting || !allowed || !body.trim()}
          onClick={() => void submit()}
        >
          <SendIcon className="size-3.5" /> {posting ? "Posting…" : "Reply"}
        </PullRequestPermissionButton>
      </div>
    </div>
  );
}
