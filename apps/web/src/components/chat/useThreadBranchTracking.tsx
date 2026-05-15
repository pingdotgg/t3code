import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import {
  resolveThreadBranchAutoLink,
  resolveThreadBranchMismatch,
  type ThreadBranchMismatch,
} from "../../lib/threadBranchTracking";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

interface UseThreadBranchTrackingInput {
  // Auto-link + relink only fire for server threads. Drafts capture their
  // branch via the createThread bootstrap on first send (see ChatView).
  readonly threadRef: ScopedThreadRef | null;
  readonly threadBranch: string | null;
  readonly worktreePath: string | null;
  readonly projectCwd: string | null;
  readonly gitStatus: VcsStatusResult | null;
  // True while a turn is mid-send so we don't race with thread.turn.start.
  readonly isSendInFlight: boolean;
}

/**
 * Per-chat branch tracking glue:
 * - Auto-links a server thread to the current ref the first time we observe
 *   it without a branch (older chats get tagged transparently on open).
 * - Builds a banner item for ComposerBannerStack when the chat's stored
 *   branch differs from the working tree's ref. The banner exposes two
 *   explicit choices: checkout the chat's branch, or relink to the current.
 */
export function useThreadBranchTracking(input: UseThreadBranchTrackingInput): {
  readonly mismatchBannerItem: ComposerBannerStackItem | null;
} {
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  // Dedupe key — guards StrictMode double-fires and effect re-runs while
  // the dispatched event is still propagating back through the store.
  const lastAutoLinkedRef = useRef<string | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);

  useEffect(() => {
    if (!input.threadRef || input.isSendInFlight) return;
    const autoLink = resolveThreadBranchAutoLink({
      threadBranch: input.threadBranch,
      gitStatus: input.gitStatus,
    });
    if (!autoLink) return;

    const dedupeKey = `${input.threadRef.environmentId}:${input.threadRef.threadId}:${autoLink.branch}`;
    if (lastAutoLinkedRef.current === dedupeKey) return;
    lastAutoLinkedRef.current = dedupeKey;

    const api = readEnvironmentApi(input.threadRef.environmentId);
    if (!api) return;

    // Optimistic local write so the badge updates immediately. Server
    // command is fire-and-forget; if it loses, the next snapshot wins.
    setThreadBranch(input.threadRef, autoLink.branch, input.worktreePath);
    void api.orchestration
      .dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.threadRef.threadId,
        branch: autoLink.branch,
        worktreePath: input.worktreePath,
      })
      .catch(() => undefined);
  }, [
    input.gitStatus,
    input.isSendInFlight,
    input.threadBranch,
    input.threadRef,
    input.worktreePath,
    setThreadBranch,
  ]);

  const mismatch = useMemo(
    () =>
      resolveThreadBranchMismatch({
        threadBranch: input.threadBranch,
        currentBranch: input.gitStatus?.refName ?? null,
      }),
    [input.gitStatus?.refName, input.threadBranch],
  );

  const handleCheckout = useCallback(
    async (target: ThreadBranchMismatch) => {
      if (!input.threadRef || !input.projectCwd) return;
      const api = readEnvironmentApi(input.threadRef.environmentId);
      if (!api) return;
      // Run checkout against the same working tree the status query points
      // at — worktree path if any, otherwise the project root.
      const checkoutCwd = input.worktreePath ?? input.projectCwd;
      setIsActionPending(true);
      try {
        await api.vcs.switchRef({ cwd: checkoutCwd, refName: target.threadBranch });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch branch.",
            description: error instanceof Error ? error.message : "Unknown error.",
          }),
        );
      } finally {
        setIsActionPending(false);
      }
    },
    [input.projectCwd, input.threadRef, input.worktreePath],
  );

  const handleRelink = useCallback(
    async (target: ThreadBranchMismatch) => {
      if (!input.threadRef) return;
      const api = readEnvironmentApi(input.threadRef.environmentId);
      if (!api) return;
      setIsActionPending(true);
      setThreadBranch(input.threadRef, target.currentBranch, input.worktreePath);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadRef.threadId,
          branch: target.currentBranch,
          worktreePath: input.worktreePath,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to relink chat to current branch.",
            description: error instanceof Error ? error.message : "Unknown error.",
          }),
        );
      } finally {
        setIsActionPending(false);
      }
    },
    [input.threadRef, input.worktreePath, setThreadBranch],
  );

  const mismatchBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!mismatch) return null;
    return {
      id: `branch-mismatch:${mismatch.threadBranch}->${mismatch.currentBranch}`,
      variant: "warning",
      icon: <GitBranchIcon />,
      title: (
        <>
          Chat is on <code className="font-mono text-[0.95em]">{mismatch.threadBranch}</code>,
          checkout is on <code className="font-mono text-[0.95em]">{mismatch.currentBranch}</code>
        </>
      ),
      description:
        "Continuing now would run the agent against a different branch. Switch the working tree, or relink this chat to the current branch.",
      actions: (
        <>
          <Button
            size="xs"
            disabled={isActionPending}
            onClick={() => void handleCheckout(mismatch)}
          >
            Checkout {mismatch.threadBranch}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={isActionPending}
            onClick={() => void handleRelink(mismatch)}
          >
            Relink to {mismatch.currentBranch}
          </Button>
        </>
      ),
    };
  }, [handleCheckout, handleRelink, isActionPending, mismatch]);

  return { mismatchBannerItem };
}
