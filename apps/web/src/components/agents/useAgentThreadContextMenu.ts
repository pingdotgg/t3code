import { msg } from "gt-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { readThreadShell, useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { useClientSettings } from "../../hooks/useSettings";
import { requestThreadRename } from "../ThreadRenameDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  buildAgentThreadMenuItems,
  planAgentThreadMove,
  type AgentRunContextMenu,
  type AgentThreadMenuId,
} from "./agents.logic";
import { useAgentThreadShells, useSetAgentRunParent } from "./useAgentRunParenting";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      title,
      description: error instanceof Error ? error.message : "Try again.",
      type: "error",
    }),
  );
}

/**
 * The Agents workspace's per-chat menu. It is invoked once at the board level
 * (not per card) so a board with many chat cards does not subscribe each card
 * to projects, settings, and the thread action commands.
 */
export function useAgentThreadContextMenu(
  visible: readonly EnvironmentThreadShell[],
): AgentRunContextMenu {
  const threads = useAgentThreadShells();
  const setParent = useSetAgentRunParent();
  const router = useRouter();
  const projects = useProjects();
  const {
    reorderActiveThread,
    settleThread,
    unsettleThread,
    pinThread,
    confirmAndUnpinThread,
    confirmAndDeleteThread,
    archiveThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: {
      target: "branch name",
      unavailableMessage: msg("Clipboard API is unavailable while copying branch name."),
      failureMessage: msg("Failed to copy branch name to the clipboard."),
    },
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: string }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Chat ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy chat ID", error),
  });

  return async (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
    siblings?: readonly EnvironmentThreadShell[],
  ) => {
    const api = readLocalApi();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const current = readThreadShell(ref);
    if (!api || !current) return;
    const settled = current.settledAt !== null;
    const pinned = current.pinnedAt != null;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === current.environmentId && candidate.id === current.projectId,
    );
    const workspacePath = current.worktreePath ?? project?.workspaceRoot ?? null;
    const planMove = (direction: "up" | "down") => {
      const refresh = (items: readonly EnvironmentThreadShell[]) =>
        items.flatMap((item) => {
          const shell = readThreadShell(scopeThreadRef(item.environmentId, item.id));
          return shell ? [shell] : [];
        });
      const plan = planAgentThreadMove(refresh(visible), refresh(threads), current, direction);
      return plan;
    };
    const items = buildAgentThreadMenuItems({
      pinned,
      settled,
      isChildRow: siblings !== undefined,
      canMoveUp: !pinned && !settled && !siblings && Boolean(planMove("up")),
      canMoveDown: !pinned && !settled && !siblings && Boolean(planMove("down")),
      isRegeneratingTitle: current.titleRegeneration != null,
      // The board's view, which includes a pending move.
      hasParent: thread.parentThreadId != null,
      hasWorkspacePath: workspacePath !== null,
      hasBranch: Boolean(current.branch),
    });
    let action: AgentThreadMenuId | null;
    try {
      action = await api.contextMenu.show(items, position);
    } catch (error) {
      failureToast("Could not open the chat menu", error);
      return;
    }
    if (!action) return;

    const reportFailure = async (
      title: string,
      run: () => Promise<AtomCommandResult<unknown, unknown>>,
    ) => {
      const result = await run();
      if (result._tag === "Failure") {
        failureToast(title, squashAtomCommandFailure(result));
      }
    };

    switch (action) {
      case "move-up":
      case "move-down": {
        const plan = planMove(action === "move-up" ? "up" : "down");
        if (!plan) return;
        for (const { thread: target, orderKey } of plan) {
          const result = await reorderActiveThread(
            scopeThreadRef(target.environmentId, target.id),
            orderKey,
          );
          if (result._tag === "Failure") {
            failureToast("Failed to move chat", squashAtomCommandFailure(result));
            return;
          }
        }
        return;
      }
      case "pin":
        await reportFailure("Failed to pin chat", () => pinThread(ref));
        return;
      case "unpin":
        await reportFailure("Failed to unpin chat", () => confirmAndUnpinThread(ref));
        return;
      case "settle":
        await reportFailure("Failed to settle chat", () => settleThread(ref));
        return;
      case "unsettle":
        await reportFailure("Failed to un-settle chat", () => unsettleThread(ref));
        return;
      case "rename": {
        const title = await requestThreadRename(current.title);
        if (title === null) return;
        await reportFailure("Failed to rename chat", () =>
          updateThreadMetadata({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, title },
          }),
        );
        return;
      }
      case "regenerate-title":
        await reportFailure("Failed to regenerate chat title", () =>
          updateThreadMetadata({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, regenerateTitle: true },
          }),
        );
        return;
      case "mark-unread":
        markThreadUnread(scopedThreadKey(ref), current.latestRun?.completedAt);
        return;
      case "detach-parent":
        // Same path as dragging a child out: optimistic, rolled back on failure.
        await setParent(thread, null);
        return;
      case "copy-path":
        if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
        return;
      case "copy-branch":
        if (current.branch) copyBranchToClipboard(current.branch, { branch: current.branch });
        return;
      case "copy-thread-id":
        copyThreadIdToClipboard(ref.threadId, { threadId: ref.threadId });
        return;
      case "archive": {
        if (confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(`Archive chat "${current.title}"?`);
          if (!confirmed) return;
        }
        await reportFailure("Failed to archive chat", () =>
          archiveThread(ref, {
            onArchived: () => {
              void router.navigate({ to: "/agents" });
            },
          }),
        );
        return;
      }
      case "delete":
        await reportFailure("Failed to delete chat", () => confirmAndDeleteThread(ref));
        return;
    }
  };
}

/**
 * The Agents board's inline settle action, called by a card's own control.
 * Settling a settled chat un-settles it, exactly like the right-click menu, so
 * the card button reuses one lifecycle and one version-skew guard instead of a
 * parallel path. Failures surface through the same toast the menu uses.
 */
export function useAgentThreadSettleAction(): (thread: EnvironmentThreadShell) => void {
  const { settleThread, unsettleThread } = useThreadActions();
  return async (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const current = readThreadShell(ref) ?? thread;
    const settled = current.settledAt !== null;
    const result = await (settled ? unsettleThread(ref) : settleThread(ref));
    if (result._tag === "Failure") {
      failureToast(
        settled ? "Failed to un-settle chat" : "Failed to settle chat",
        squashAtomCommandFailure(result),
      );
    }
  };
}
