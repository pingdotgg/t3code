import {
  PullRequestPermissionMenuItem,
  PullRequestPermissionButton,
} from "./PullRequestPermissionButton";
import { usePullRequestDeniedActions } from "./PullRequestReviewContext";
import { useAtomValue } from "@effect/atom-react";
import { pullRequestSuggestion } from "@t3tools/shared/pullRequestSuggestion";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestComment,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  ThumbsUpIcon,
  Trash2Icon,
  ExternalLinkIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useOpenLink } from "~/browser/useOpenLink";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

export function PullRequestCommentActions({
  comment,
  environmentId,
  reference,
  threadRef,
  canEdit,
  canDelete,
  canLike,
  suggestionHead,
  onEdit,
}: {
  comment: PullRequestComment;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadRef?: ScopedThreadRef | null;
  canEdit: boolean;
  canDelete: boolean;
  canLike: boolean;
  suggestionHead?: string | undefined;
  onEdit: () => void;
}) {
  const denied = usePullRequestDeniedActions();
  const suggestionAllowed = useAtomValue(
    pullRequestEnvironment.runHostAction.permissionAtom(environmentId),
  );
  const nativeAction = useAtomCommand(pullRequestEnvironment.runHostAction, {
    reportFailure: false,
  });
  const [confirmSuggestion, setConfirmSuggestion] = useState(false);
  const canSuggest =
    suggestionHead !== undefined &&
    comment.kind === "review-comment" &&
    (comment.threadStatus === undefined ||
      comment.threadStatus === "active" ||
      comment.threadStatus === "pending") &&
    pullRequestSuggestion(comment.body) !== null;
  const deleteAllowed = useAtomValue(
    pullRequestEnvironment.deleteComment.permissionAtom(environmentId),
  );
  const editAllowed = useAtomValue(
    pullRequestEnvironment.updateComment.permissionAtom(environmentId),
  );
  const likeAllowed = useAtomValue(
    pullRequestEnvironment.setReaction.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(pullRequestEnvironment.deleteComment, { reportFailure: false });
  const react = useAtomCommand(pullRequestEnvironment.setReaction, { reportFailure: false });
  const openLink = useOpenLink(threadRef);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const like = comment.reactions?.find((reaction) => reaction.content === "thumbs-up");
  // The server refreshes every client's activity after a mutation, so none is requested here.
  const run = async <A, E>(
    mutation: () => Promise<AtomCommandResult<A, E>>,
    failure: string,
    succeeded: (value: A) => void,
  ) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    await Promise.resolve()
      .then(mutation)
      .then((result) => {
        if (result._tag === "Failure") setError(failure);
        else succeeded(result.value);
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const toggleLike = () => {
    if (!canLike || !likeAllowed) return;
    void run(
      () =>
        react({
          environmentId,
          input: {
            ...reference,
            subjectId: comment.id,
            content: "thumbs-up",
            reacted: !like?.viewerHasReacted,
          },
        }),
      "Could not update the like.",
      () => {},
    );
  };
  const applySuggestion = () => {
    if (!canSuggest || !suggestionAllowed || !suggestionHead) return;
    void run(
      () =>
        nativeAction({
          environmentId,
          input: {
            ...reference,
            action: {
              type: "apply-suggestion",
              commentId: comment.id,
              expectedHead: suggestionHead,
            },
          },
        }),
      "Could not apply the suggestion. Refresh the PR and check that the source branch has not changed.",
      (value) => {
        setConfirmSuggestion(false);
        toastManager.add({ type: "info", title: value.message });
      },
    );
  };
  const deleteComment = () => {
    if (!canDelete || !deleteAllowed || comment.kind === "review") return;
    const kind = comment.kind;
    void run(
      () => remove({ environmentId, input: { ...reference, commentId: comment.id, kind } }),
      "Could not delete the comment.",
      () => setConfirm(false),
    );
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        {canLike ? (
          <PullRequestPermissionButton
            reason={denied["like-comment"]}
            size={like && like.count > 0 ? "xs" : "icon-xs"}
            variant={like?.viewerHasReacted ? "outline" : "ghost-muted"}
            aria-label={like?.viewerHasReacted ? "Unlike comment" : "Like comment"}
            aria-pressed={like?.viewerHasReacted === true}
            title={like?.viewerHasReacted ? "Unlike comment" : "Like comment"}
            disabled={!likeAllowed || busy}
            onClick={toggleLike}
          >
            <ThumbsUpIcon />
            {like && like.count > 0 ? like.count : null}
          </PullRequestPermissionButton>
        ) : null}
        {canEdit ? (
          <PullRequestPermissionButton
            reason={denied["edit-comment"]}
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Edit comment"
            title="Edit comment"
            disabled={!editAllowed || busy}
            onClick={onEdit}
          >
            <PencilIcon />
          </PullRequestPermissionButton>
        ) : null}
        {canDelete ? (
          <PullRequestPermissionButton
            reason={denied["delete-comment"]}
            size="icon-xs"
            variant="ghost-destructive"
            aria-label="Delete comment"
            title="Delete comment"
            disabled={!deleteAllowed || busy}
            onClick={() => {
              setError(null);
              setConfirm(true);
            }}
          >
            <Trash2Icon />
          </PullRequestPermissionButton>
        ) : null}
        {error && !confirm ? (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Comment actions"
                disabled={busy}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end">
            {comment.url ? (
              <MenuItem onClick={() => void writeTextToClipboard(comment.url!, "comment link")}>
                <LinkIcon />
                Copy link
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => void writeTextToClipboard(comment.body, "comment text")}>
              <CopyIcon />
              Copy text
            </MenuItem>
            {comment.url ? (
              <MenuItem onClick={() => void openLink(comment.url!)}>
                <ExternalLinkIcon />
                Open on host
              </MenuItem>
            ) : null}
            {canSuggest ? (
              <PullRequestPermissionMenuItem
                disabled={!suggestionAllowed || busy || Boolean(denied["apply-suggestion"])}
                reason={denied["apply-suggestion"]}
                onClick={() => {
                  setError(null);
                  setConfirmSuggestion(true);
                }}
              >
                <PencilIcon />
                Apply suggestion
              </PullRequestPermissionMenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <AlertDialog
        open={confirmSuggestion}
        onOpenChange={(value) => {
          if (!pending.current) setConfirmSuggestion(value);
        }}
      >
        <AlertDialogPopup backdropVariant="dimmed">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply suggestion?</AlertDialogTitle>
            <AlertDialogDescription>
              Commit the suggested code to the source branch of PR #{reference.number}. Refresh
              first if the branch has changed.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmSuggestion(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !suggestionAllowed} onClick={applySuggestion}>
              {busy ? "Applying…" : "Apply suggestion"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={confirm}
        onOpenChange={(value) => {
          if (!pending.current) setConfirm(value);
        }}
      >
        <AlertDialogPopup backdropVariant="dimmed">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your comment from the pull request.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <PullRequestPermissionButton
              reason={denied["delete-comment"]}
              variant="destructive"
              disabled={busy || !deleteAllowed}
              onClick={deleteComment}
            >
              {busy ? "Deleting…" : "Delete comment"}
            </PullRequestPermissionButton>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
