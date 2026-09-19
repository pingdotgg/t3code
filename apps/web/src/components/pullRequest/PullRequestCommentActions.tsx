import type { PullRequestReviewThread } from "@t3tools/contracts";
import {
  CheckIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
} from "lucide-react";
import { createContext, useContext } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import type { PullRequestCommentReference } from "./pullRequestDetail.logic";

export const PullRequestCommentActionsContext = createContext<{
  add: (comment: PullRequestCommentReference) => void;
  disabled: boolean;
  threads: ReadonlyMap<string, PullRequestReviewThread>;
  resolve?: (thread: PullRequestReviewThread) => void;
} | null>(null);

export function PullRequestCommentActions({
  comment,
  showResolution = false,
  onEdit,
  disabled = false,
}: {
  comment: PullRequestCommentReference;
  showResolution?: boolean;
  onEdit?: () => void;
  disabled?: boolean;
}) {
  const actions = useContext(PullRequestCommentActionsContext);
  const thread = showResolution ? actions?.threads.get(comment.id) : undefined;
  const busy = disabled || actions?.disabled === true;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "comment link",
    onError: () => toastManager.add({ type: "error", title: "Could not copy the comment link" }),
  });
  if (!comment.url && !actions && !onEdit) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {thread && thread.canResolve !== false && actions?.resolve ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => actions.resolve?.(thread)}>
          {thread.isResolved ? "Reopen" : "Resolve"}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-xs" variant="ghost" aria-label="Comment actions" />}
        >
          <MoreHorizontalIcon aria-hidden className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEdit ? (
            <DropdownMenuItem disabled={busy} onClick={onEdit}>
              <PencilIcon className="size-3.5" />
              Edit comment
            </DropdownMenuItem>
          ) : null}
          {comment.url ? (
            <DropdownMenuItem onClick={() => copyToClipboard(comment.url!)}>
              {isCopied ? <CheckIcon className="size-3.5" /> : <LinkIcon className="size-3.5" />}
              {isCopied ? "Link copied" : "Copy comment link"}
            </DropdownMenuItem>
          ) : null}
          {actions ? (
            <DropdownMenuItem disabled={busy} onClick={() => actions.add(comment)}>
              <MessageSquarePlusIcon className="size-3.5" />
              Add to composer
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
