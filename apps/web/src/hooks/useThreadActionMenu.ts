import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { openGuestShareDialog } from "../components/chat/guestShareDialogState";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  parseMachineMovePick,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { titleRegenerationToast } from "../components/threadTitleRegenerationToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { m } from "../i18n/messages";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import { configuredHostedAppUrl } from "../hostedPairing";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import {
  canTurnThreadIntoProject,
  confirmThreadMove,
  readThreadMachineMoveTargets,
  readThreadMoveTargets,
  useThreadActions,
} from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
    }),
  );
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly canShareWithGuest: boolean;
}) {
  const { threadRef, projectCwd, onStartRename, onFind, canShareWithGuest } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
  });
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    turnThreadIntoProject,
    moveThreadToProject,
    moveThreadToMachine,
  } = useThreadActions();
  const regenerateThreadTitle = useOrchestrationCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onError: (error) => failureToast(m(msg("Failed to copy path")), error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: {
      target: "branch name",
      unavailableMessage: msg("Clipboard API is unavailable while copying branch name."),
      failureMessage: msg("Failed to copy branch name to the clipboard."),
    },
    onError: (error) => failureToast(m(msg("Failed to copy branch")), error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onError: (error) => failureToast(m(msg("Failed to copy thread ID")), error),
  });

  const openMenu = (position: { x: number; y: number }) => {
    if (threadRef === null) return;
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const thread = readThreadShell(threadRef);
      if (!thread) {
        failureToast(
          m(msg("Thread actions unavailable")),
          new Error(m(msg("This thread has not loaded yet."))),
        );
        return;
      }
      const now = new Date();
      const configLoaded = readEnvironmentServerConfigLoaded(threadRef.environmentId);
      const supports = {
        settlement: configLoaded,
        autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
        snooze: configLoaded,
        pinning: configLoaded,
        titleRegeneration: configLoaded,
      };
      const isRegeneratingTitle = thread.titleRegeneration != null;
      const snoozePresets = resolveSnoozePresets(now, timestampFormat, threadRef.environmentId);
      const machineMoveTargets = readThreadMachineMoveTargets(threadRef);
      const items = buildThreadActionMenuItems({
        canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        canFind: onFind !== undefined,
        branch: thread.branch ?? null,
        projectFilter: null,
        isPinned: thread.pinnedAt != null,
        isSettled: supports.settlement && thread.settledOverride === "settled",
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        isRunning: !threadRuntimeCanArchive(thread.runtime),
        supports,
        snoozePresets,
        canShareWithGuest,
        canTurnIntoProject: canTurnThreadIntoProject(threadRef),
        moveTargets: readThreadMoveTargets(threadRef),
        machineMoveTargets,
      });
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const action: ThreadActionMenuId = clicked.value;
      if (
        threadActionRequiresOperate(action) &&
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        failureToast(
          m(msg("Thread action unavailable")),
          new Error(m(msg("This connection cannot change threads."))),
        );
        return;
      }
      if (action.startsWith("snooze:")) {
        const preset =
          action === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                action.slice("snooze:".length),
                timestampFormat,
                threadRef.environmentId,
              );
        if (!preset) return;
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(m(msg("Failed to snooze thread")), squashAtomCommandFailure(result));
        }
        return;
      }
      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };
      const machinePick = parseMachineMovePick(action, machineMoveTargets);
      if (machinePick) {
        await moveThreadToMachine(threadRef, {
          environmentId: machinePick.machine.environmentId,
          projectId: machinePick.project.id,
        });
        return;
      }
      if (action.startsWith("move-to-project:")) {
        const projectId = ProjectId.make(action.slice("move-to-project:".length));
        if (!(await confirmThreadMove(threadRef, projectId))) return;
        await reportFailure(m(msg("Could not move thread")), () =>
          moveThreadToProject(threadRef, projectId),
        );
        return;
      }
      switch (action) {
        case "find":
          onFind?.(threadRef);
          return;
        case "project-settings": {
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          if (!project) return;
          const projectKey =
            logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
            deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey },
          });
          return;
        }
        case "new-thread-on-branch": {
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast(m(msg("Could not create thread")), squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle":
          await reportFailure(m(msg("Failed to settle thread")), () => settleThread(threadRef));
          return;
        case "unsettle":
          await reportFailure(m(msg("Failed to un-settle thread")), () =>
            unsettleThread(threadRef),
          );
          return;
        case "unsnooze":
          await reportFailure(m(msg("Failed to wake thread")), () => unsnoozeThread(threadRef));
          return;
        case "pin":
          await reportFailure(m(msg("Failed to pin thread")), () => pinThread(threadRef));
          return;
        case "unpin": {
          await reportFailure(m(msg("Failed to unpin thread")), () =>
            confirmAndUnpinThread(threadRef),
          );
          return;
        }
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure(m(msg("Failed to update auto-settle")), () =>
            setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
          );
          return;
        case "rename":
          onStartRename();
          return;
        case "regenerate-title": {
          if (isRegeneratingTitle) return;
          const toast = titleRegenerationToast([
            await regenerateThreadTitle({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            }),
          ]);
          if (toast) toastManager.add(toast);
          return;
        }
        case "mark-unread":
          markThreadUnread(threadRef);
          return;
        case "share-guest":
          openGuestShareDialog(threadRef);
          return;
        case "turn-into-project": {
          const result = await turnThreadIntoProject(threadRef);
          if (result._tag === "Success") {
            toastManager.add({
              type: "success",
              title: m(msg("Project created")),
              description: thread.title,
            });
          } else if (!isAtomCommandInterrupted(result)) {
            failureToast(
              m(msg("Could not turn thread into a project")),
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "copy-path": {
          const workspacePath = thread.worktreePath ?? projectCwd;
          if (!workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: m(msg("Path unavailable")),
                description: m(msg("This thread does not have a workspace path to copy.")),
              }),
            );
            return;
          }
          copyPathToClipboard(workspacePath, { path: workspacePath });
          return;
        }
        case "copy-branch":
          if (thread.branch) {
            copyBranchToClipboard(thread.branch, { branch: thread.branch });
          }
          return;
        case "copy-thread":
          void copyThreadReference(
            threadChipCopyTarget(threadRef, thread.title, configuredHostedAppUrl(), m),
          );
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          if (confirmThreadArchive) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(m(msg('Archive thread "{title}"?', { title: thread.title }))),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          let didArchive = false;
          const result = await archiveThread(threadRef, {
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive
                ? m(msg("Thread archived, but navigation failed"))
                : m(msg("Failed to archive thread")),
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          if (confirmThreadDelete) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(
                [
                  m(msg('Delete thread "{title}"?', { title: thread.title })),
                  m(msg("This permanently clears conversation history for this thread.")),
                ].join("\n"),
                { variant: "destructive" },
              ),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const deleted = await deleteThread(threadRef);
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A missing thread means cleanup failed after deletion; deleteThread already toasted that failure.
            readThreadShell(threadRef) !== null
          ) {
            failureToast(m(msg("Failed to delete thread")), squashAtomCommandFailure(deleted));
          }
          return;
        }
        default:
          return;
      }
    })();
  };

  const closeMenu = () => {
    void readLocalApi()?.contextMenu.close();
  };

  return { openMenu, closeMenu };
}
