import { thrownErrorMessage } from "@lathe/client-runtime/errors";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { customSnoozeOptions } from "../components/CustomSnoozeDialog.logic";
import { openThreadDependencyPicker } from "../commandPaletteBus";
import { scopeProjectRef } from "@lathe/client-runtime/environment";
import { openGuestShareDialog } from "../components/chat/guestShareDialogState";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lathe/client-runtime/state/runtime";
import {
  canAddDependency,
  canSnooze,
  effectiveBlocked,
  effectiveSnoozed,
} from "@lathe/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@lathe/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { titleRegenerationToast } from "../components/threadTitleRegenerationToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { m } from "../i18n/messages";
import { threadChipCopyTarget } from "@lathe/client-runtime/thread-reference";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readCanContinueThread,
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsDependencies,
  readEnvironmentSupportsHighlight,
  readEnvironmentSupportsSnoozeReminder,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { copyThreadChip } from "../lib/copyThreadChip";
import { readLocalApi } from "../localApi";
import { configuredHostedAppUrl } from "../hostedPairing";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@lathe/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@lathe/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { continueInNewThreadOptions, useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { canTurnThreadIntoProject, useThreadActions } from "./useThreadActions";
// Fork: roadmap.
import { useRoadmapThreadActions } from "../components/roadmap/useRoadmapThreadActions";

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
    releaseThreadDependencies,
    pinThread,
    confirmAndUnpinThread,
    setThreadHighlight,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    turnThreadIntoProject,
  } = useThreadActions();
  const regenerateThreadTitle = useOrchestrationCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  // Fork: roadmap.
  const { actions: roadmapActions, availability: roadmapAvailability } = useRoadmapThreadActions();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const threadHighlightPalette = useClientSettings((s) => s.threadHighlightPalette);
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

  // Fork: roadmap. Typed so the roadmap toggle can reopen the menu from inside it.
  const openMenu = (position: { x: number; y: number }): void => {
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
        snoozeReminder: readEnvironmentSupportsSnoozeReminder(threadRef.environmentId),
        pinning: configLoaded,
        highlight: readEnvironmentSupportsHighlight(threadRef.environmentId),
        titleRegeneration: configLoaded,
        dependencies: readEnvironmentSupportsDependencies(threadRef.environmentId),
        // Fork: roadmap.
        roadmap: roadmapAvailability.supported,
      };
      const isRegeneratingTitle = thread.titleRegeneration != null;
      const snoozePresets = resolveSnoozePresets(now, timestampFormat, threadRef.environmentId);
      const isSnoozed = supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() });
      const items = buildThreadActionMenuItems({
        canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        canFind: onFind !== undefined,
        branch: thread.branch ?? null,
        canContinueInNewThread: readCanContinueThread(threadRef.environmentId, thread.projectId),
        // The chat header has no project-scoped thread list behind the
        // menu, so the "Filter by project" affordance is sidebar-only.
        projectFilter: null,
        isPinned: thread.pinnedAt != null,
        highlightColor: thread.highlightColor ?? null,
        highlightPalette: threadHighlightPalette,
        isSettled: supports.settlement && thread.settledOverride === "settled",
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed,
        snoozeReminder: thread.snoozeReminder ?? null,
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isBlocked: supports.dependencies && effectiveBlocked(thread),
        canAddDependencyNow: canAddDependency(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        isRunning: !threadRuntimeCanArchive(thread.runtime),
        supports,
        snoozePresets,
        // Fork: roadmap.
        roadmap: roadmapActions.menuState(threadRef),
        canShareWithGuest,
        canTurnIntoProject: canTurnThreadIntoProject(threadRef),
      });
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const action: ThreadActionMenuId = clicked.value;
      // Fork: roadmap.
      const roadmapOutcome = roadmapActions.handleMenuAction(action, thread);
      if (roadmapOutcome === "reopen") {
        openMenu(position);
        return;
      }
      if (roadmapOutcome !== null) return;
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
      if (action.startsWith("highlight:")) {
        const color =
          action === "highlight:default"
            ? null
            : (threadHighlightPalette[Number(action.slice("highlight:".length))]?.color ??
              undefined);
        if (color === undefined) return;
        const result = await setThreadHighlight(threadRef, color);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(m(msg("Failed to highlight thread")), squashAtomCommandFailure(result));
        }
        return;
      }
      if (action.startsWith("snooze:")) {
        const choice =
          action === "snooze:custom" || action === "snooze:reminder"
            ? await requestCustomSnooze(
                customSnoozeOptions({
                  focusReminder: action === "snooze:reminder",
                  supportsReminder: supports.snoozeReminder,
                  snoozed: isSnoozed ? thread : null,
                }),
              )
            : pickSnoozePreset(
                snoozePresets,
                action.slice("snooze:".length),
                timestampFormat,
                threadRef.environmentId,
              );
        if (!choice) return;
        const result = await snoozeThread(
          threadRef,
          choice.snoozedUntil,
          "reminder" in choice ? choice.reminder : undefined,
        );
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
        case "continue-in-new-thread": {
          const result = await settlePromise(() =>
            handleNewThread(
              scopeProjectRef(threadRef.environmentId, thread.projectId),
              continueInNewThreadOptions(thread),
            ),
          );
          if (result._tag === "Failure") {
            failureToast(m(msg("Could not create thread")), squashAtomCommandFailure(result));
          }
          return;
        }
        case "new-thread-to-unblock": {
          // Same carry-over as "New thread on branch"; the draft also
          // remembers which thread it unblocks, and the link is made once
          // the new thread actually exists (first send).
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
              unblocksThreadId: thread.id,
            }),
          );
          if (result._tag === "Failure") {
            failureToast(m(msg("Could not create thread")), squashAtomCommandFailure(result));
          }
          return;
        }
        case "depends-on":
          openThreadDependencyPicker(threadRef);
          return;
        case "release": {
          const released = await releaseThreadDependencies(threadRef);
          if (released._tag === "Failure") {
            if (!isAtomCommandInterrupted(released)) {
              failureToast(m(msg("Failed to wake thread")), squashAtomCommandFailure(released));
            }
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: m(msg("Thread woke")),
              timeout: 5_000,
            }),
          );
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
        case "highlight":
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
        case "copy-thread-chip":
          await copyThreadChip({ environmentId: threadRef.environmentId, thread });
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
