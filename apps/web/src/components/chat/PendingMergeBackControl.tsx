import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolvePendingMergeBack } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** The side chat or fork this thread will receive with its next message, and a way to cancel it. */
export function PendingMergeBackControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const pending = resolvePendingMergeBack(useQuietThreadProjection(ref)?.projection);
  const source = useQuietThreadShell(
    pending === null ? null : scopeThreadRef(props.environmentId, pending.sourceThreadId),
  );
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const cancelMergeBack = useAtomCommand(threadEnvironment.cancelMergeBack, {
    reportFailure: false,
  });
  const [cancelling, setCancelling] = useState(false);
  if (pending === null) return null;

  const label =
    source === null
      ? "Another thread"
      : `${source.lineage.sideChat ? "Side chat" : "Fork"} “${source.title}”`;
  const cancel = async () => {
    setCancelling(true);
    const result = await cancelMergeBack({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, transferId: pending.id },
    });
    setCancelling(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not cancel the merge-back",
      ...(error instanceof Error ? { description: error.message } : {}),
    });
  };

  return (
    <div
      data-pending-merge-back
      className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center justify-end gap-1.5 pb-3 text-xs text-muted-foreground"
    >
      <PullRequestGlyph.merged aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label} goes with your next message</span>
      {canOperate ? (
        <Button size="xs" variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
