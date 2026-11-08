import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolvePendingMergeBack } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** The side chat or fork this thread's next message carries, and a way to cancel it. */
export function usePendingMergeBackBanner(
  environmentId: EnvironmentId,
  projection: ThreadStructure | null,
): ComposerBannerStackItem | null {
  const pending = resolvePendingMergeBack(projection);
  const source = useQuietThreadShell(
    pending === null ? null : scopeThreadRef(environmentId, pending.sourceThreadId),
  );
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cancelMergeBack = useAtomCommand(threadEnvironment.cancelMergeBack, {
    reportFailure: false,
  });
  const [cancelling, setCancelling] = useState(false);
  if (pending === null || projection === null) return null;

  const cancel = async () => {
    setCancelling(true);
    const result = await cancelMergeBack({
      environmentId,
      input: { threadId: projection.thread.id, transferId: pending.id },
    });
    setCancelling(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not cancel the merge-back",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  return {
    id: `pending-merge-back:${pending.id}`,
    variant: "info",
    icon: <PullRequestGlyph.merged />,
    title: `Your next message brings back ${
      source === null
        ? "another thread"
        : `${source.lineage.sideChat ? "side chat" : "fork"} “${source.title}”`
    }`,
    ...(canOperate
      ? {
          actions: (
            <Button size="xs" variant="ghost" disabled={cancelling} onClick={() => void cancel()}>
              Cancel
            </Button>
          ),
        }
      : {}),
  };
}
