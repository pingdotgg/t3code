import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { formatEnvironmentQueryError } from "~/state/query";
import { toastManager } from "../ui/toast";
import { ReviewThreadCard } from "./PullRequestReviewAnnotation";
import { canEditPullRequestComment } from "./pullRequestEditing.logic";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";

export function PullRequestConversation({
  thread,
  detail,
  environmentId,
  reference,
  onRefresh,
  onFixFinding,
  pendingFinding,
  fixLabel,
}: {
  thread: PullRequestReviewThread;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onRefresh: () => void;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
  pendingFinding?: string | null | undefined;
  fixLabel?: string | undefined;
}) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const reply = useAtomCommand(pullRequestEnvironment.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const update = useAtomCommand(pullRequestEnvironment.updateComment, { reportFailure: false });
  const load = useAtomCommand(pullRequestEnvironment.threadComments, { reportFailure: false });
  const run = async (title: string, command: () => Promise<AtomCommandResult<void, unknown>>) => {
    if (running.current) return false;
    running.current = true;
    setPending(true);
    try {
      const result = await command();
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title,
          description: formatEnvironmentQueryError(result.cause),
        });
        return false;
      }
      onRefresh();
      return true;
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <ReviewThreadCard
      thread={thread}
      workspaceRoot={detail.workspaceRoot}
      canReply={detail.capabilities.review.reply && detail.viewerPermissions.comment}
      canResolve={detail.capabilities.review.resolve && detail.viewerPermissions.resolve}
      canReact={detail.capabilities.reactions === true}
      environmentId={environmentId}
      reference={reference}
      pending={pending}
      fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
      {...(fixLabel ? { fixLabel } : {})}
      {...(onFixFinding && !thread.isResolved
        ? { onFix: () => onFixFinding({ kind: "thread", thread }) }
        : {})}
      onLoadMore={async (cursor) => {
        const result = await load({
          environmentId,
          input: { ...reference, threadId: thread.id, cursor },
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "More comments could not be loaded",
            description: formatEnvironmentQueryError(result.cause),
          });
          return null;
        }
        return result.value;
      }}
      onReply={(body) =>
        run("Reply could not be posted", () =>
          reply({ environmentId, input: { ...reference, threadId: thread.id, body } }),
        )
      }
      canEditComment={(comment) =>
        canEditPullRequestComment(detail, { author: comment.author, kind: "review-comment" })
      }
      onEditComment={(commentId, body) =>
        run("The comment could not be saved", () =>
          update({
            environmentId,
            input: { ...reference, commentId, kind: "review-comment", body },
          }),
        )
      }
      onToggleResolved={() =>
        void run("The conversation could not be updated", () =>
          resolve({
            environmentId,
            input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
          }),
        )
      }
      onReacted={onRefresh}
    />
  );
}
