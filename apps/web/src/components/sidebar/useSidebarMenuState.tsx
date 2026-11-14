import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";
import { useSidebarScopeState } from "./useSidebarScopeState";
import { useSidebarSearchState } from "./useSidebarSearchState";
import { useSidebarDragState } from "./useSidebarDragState";
import { useSidebarSnoozeState } from "./useSidebarSnoozeState";

import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../../threadSelectionStore";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  applySidebarThreadDrop,
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByProject,
  sidebarFolderExpansionKeys,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  belongsInSidebarWorkingShelf,
  isSidebarEnvironmentDisconnected,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  resolveSidebarThreadSection,
  resolveSidebarReorderableThreadKeys,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarListItemId,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type SidebarListItem,
  type SidebarSection,
  resolveSidebarRowThreadId,
} from "../Sidebar.logic";
import {
  pickSnoozePreset,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "../Sidebar.snooze";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useQuietThreadShells,
} from "../../state/entities";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "../threadActionMenu.logic";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import {
  AuthOrchestrationOperateScope,
  ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import {
  canTurnThreadIntoProject,
  useAcknowledgeThreadWoke,
  useThreadActions,
} from "../../hooks/useThreadActions";
import { openGuestShareDialog } from "../chat/guestShareDialogState";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { configuredHostedAppUrl } from "../../hostedPairing";
import type { SidebarThreadSummary } from "../../types";


function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}


function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

export function useSidebarMenuState(props: SidebarProps, params: {
  s1: ReturnType<typeof useSidebarLookupState>,
  s2: ReturnType<typeof useSidebarScopeState>,
  s3: ReturnType<typeof useSidebarSearchState>,
  s4: ReturnType<typeof useSidebarDragState>,
  s5: ReturnType<typeof useSidebarSnoozeState>,
  }) {
  const { s1, s2, s3, s4, s5 } = params;
  const { threadByKeyRef, settleThreads, settledThreadKeysRef, snoozedThreadKeysRef, attemptSettle, attemptUnsettle, attemptUnsnooze, startThreadRename } = s3;
  const { serverConfigs, timestampFormat, clearSelection, updateThreadMetadata, markThreadUnread, confirmThreadDelete, deleteThread, removeFromSelection, projectGroupsRef, projectByKey, copyPathToClipboard, copyBranchToClipboard, projectScopeKeys, setProjectScopeKeys, handleNewThread, turnThreadIntoProject, setThreadAutoSettle, copyThreadIdToClipboard, confirmThreadArchive, archiveThread } = s1;
  const { performSnooze, attemptSnooze } = s5;
  const { attemptUnpin, attemptPin } = s4;
  const { openProjectSettings } = s2;
    const handleMultiSelectContextMenu = useStableCallback(
      async (position: { x: number; y: number }) => {
        const api = readLocalApi();
        if (!api) return;
        const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
        const threadKeys = selectedThreadKeys.filter((threadKey) =>
          threadByKeyRef.current.has(threadKey),
        );
        if (threadKeys.length === 0) return;
        const count = threadKeys.length;
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        const selectionNow = new Date();
        const selectedThreads = threadKeys.flatMap((threadKey) => {
          const thread = threadByKeyRef.current.get(threadKey);
          return thread ? [thread] : [];
        });
        const settlingThreads = selectedThreads.filter(
          (thread) => thread.settledOverride !== "settled",
        );
        const canSnoozeSelection = selectedThreads.every(
          (thread) =>
            serverConfigs.has(thread.environmentId) &&
            canSnooze(thread, { now: selectionNow.toISOString() }),
        );
        const titleRegenerationThreads = selectedThreads.filter((thread) =>
          serverConfigs.has(thread.environmentId),
        );
        const regeneratableTitleThreads = titleRegenerationThreads.filter(
          (thread) => thread.titleRegeneration == null,
        );
        const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
          supportedCount: titleRegenerationThreads.length,
          actionableCount: regeneratableTitleThreads.length,
        });
        const pinnedSelectedThreads = selectedThreads.filter(
          (thread) => serverConfigs.has(thread.environmentId) && thread.pinnedAt != null,
        );
        const unpinMenuItem = buildBulkUnpinContextMenuItem({
          pinnedCount: pinnedSelectedThreads.length,
        });
        // Presets sync across environments, so the first selected thread's stand for all.
        // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
        const menuOpenedAt = new Date();
        const snoozePresets = resolveSnoozePresets(
          menuOpenedAt,
          timestampFormat,
          selectedThreads[0]!.environmentId,
        );
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(unpinMenuItem
                ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
                : []),
              {
                id: "settle",
                label: `Settle (${count})`,
                disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
              },
              ...(canSnoozeSelection
                ? [
                    {
                      id: "snooze",
                      label: `Snooze (${count})`,
                      disabled: !canOperateThreads(selectedThreads),
                      children: [
                        ...snoozePresets.map((preset) => ({
                          id: `snooze:${preset.id}`,
                          label: `${preset.label} (${preset.whenLabel})`,
                          disabled: !canOperateThreads(selectedThreads),
                        })),
                        {
                          id: "snooze:custom",
                          label: "Custom…",
                          separatorBefore: snoozePresets.length > 0,
                          disabled: !canOperateThreads(selectedThreads),
                        },
                      ],
                    },
                  ]
                : []),
              ...(titleRegenerationMenuItem
                ? [
                    {
                      ...titleRegenerationMenuItem,
                      disabled:
                        titleRegenerationMenuItem.disabled ||
                        !canOperateThreads(regeneratableTitleThreads),
                    },
                  ]
                : []),
              { id: "mark-unread", label: `Mark unread (${count})` },
              {
                id: "delete",
                label: `Delete (${count})`,
                destructive: true,
                disabled: !canOperateThreads(selectedThreads),
              },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const actionTargets =
          clicked.value === "unpin"
            ? pinnedSelectedThreads
            : clicked.value === "regenerate-title"
              ? regeneratableTitleThreads
              : clicked.value === "settle"
                ? settlingThreads.flatMap((thread) => {
                    const current = threadByKeyRef.current.get(
                      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                    );
                    return current && current.settledOverride !== "settled" ? [current] : [];
                  })
                : selectedThreads;
        if (clicked.value === "settle" && actionTargets.length === 0) return;
        if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : pickSnoozePreset(
                  snoozePresets,
                  clicked.value.slice("snooze:".length),
                  timestampFormat,
                  selectedThreads[0]!.environmentId,
                );
          if (preset) {
            const coSnoozingKeys = new Set(threadKeys);
            clearSelection();
            const outcomes = await Promise.all(
              selectedThreads.map(async (thread) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
                return { outcome, threadRef };
              }),
            );
            const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
              outcome.status === "success" ? [threadRef] : [],
            );
            const failures = outcomes.flatMap(({ outcome }) =>
              outcome.status === "failure" ? [outcome.error] : [],
            );

            if (failures.length > 0) {
              const firstError = failures[0];
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title:
                    snoozedThreadRefs.length > 0
                      ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                      : "Failed to snooze threads",
                  description:
                    firstError instanceof Error ? firstError.message : "An error occurred.",
                }),
              );
            }
          }
          return;
        }
        if (clicked.value === "unpin") {
          for (const thread of pinnedSelectedThreads) {
            attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
          }
          clearSelection();
          return;
        }
        if (clicked.value === "regenerate-title") {
          for (const thread of regeneratableTitleThreads) {
            const result = await updateThreadMetadata({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, regenerateTitle: true },
            });
            if (result._tag === "Success") continue;
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread titles",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          clearSelection();
          return;
        }
        if (clicked.value === "settle") {
          settleThreads(
            actionTargets.map((thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            ),
          );
          clearSelection();
          return;
        }
        if (clicked.value === "mark-unread") {
          for (const threadKey of threadKeys) {
            const thread = threadByKeyRef.current.get(threadKey);
            if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
          }
          clearSelection();
          return;
        }
        if (clicked.value !== "delete") return;
        if (confirmThreadDelete) {
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(
              [
                `Delete ${count} thread${count === 1 ? "" : "s"}?`,
                "This permanently clears conversation history for these threads.",
              ].join("\n"),
              { variant: "destructive" },
            ),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        if (
          !checkThreadOperations(
            threadKeys.flatMap((threadKey) => {
              const thread = threadByKeyRef.current.get(threadKey);
              return thread ? [thread] : [];
            }),
          )
        )
          return;
        const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
          entries: threadKeys.map((threadKey) => ({ threadKey })),
          delete: async ({ threadKey }, deletedThreadKeys) => {
            const thread = threadByKeyRef.current.get(threadKey);
            if (!thread) return null;
            return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
              deletedThreadKeys,
            });
          },
        });
        if (firstFailure !== null) {
          const firstError = squashAtomCommandFailure(firstFailure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete threads",
              description: firstError instanceof Error ? firstError.message : "An error occurred.",
            }),
          );
        }
        removeFromSelection(
          getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
            const threadRef = parseScopedThreadKey(threadKey);
            return threadRef !== null && readThreadShell(threadRef) !== null;
          }),
        );
      },
    );

    const handleDraftContextMenu = useStableCallback(
      (draftId: DraftId, position: { x: number; y: number }) => {
        void (async () => {
          const api = readLocalApi();
          const session = useComposerDraftStore.getState().getDraftSession(draftId);
          if (!api || !session || session.promotedTo) return;
          const projectGroup = projectGroupsRef.current.find((group) =>
            group.memberProjectRefs.some(
              (ref) =>
                ref.environmentId === session.environmentId && ref.projectId === session.projectId,
            ),
          );
          const workspacePath =
            session.worktreePath ??
            projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
          const clicked = await settlePromise(() =>
            api.contextMenu.show(
              buildDraftActionMenuItems({
                hasPath: Boolean(workspacePath),
                hasBranch: Boolean(session.branch),
                hasProject: projectGroup != null,
              }),
              position,
            ),
          );
          if (clicked._tag === "Failure") return;
          switch (clicked.value) {
            case "project-settings":
              if (projectGroup)
                openProjectSettings(projectGroup, {
                  environmentId: session.environmentId,
                  projectId: session.projectId,
                });
              return;
            case "copy-path":
              if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
              return;
            case "copy-branch":
              if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
              return;
            case "discard": {
              // The menu may outlive draft promotion; discarding then would strand the send.
              const current = useComposerDraftStore.getState().getDraftSession(draftId);
              if (current && !current.promotedTo) discardComposerDraft(draftId);
              return;
            }
          }
        })();
      },
    );

    const handleThreadContextMenu = useStableCallback(
      (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
        void (async () => {
          const api = readLocalApi();
          if (!api) return;
          const threadKey = scopedThreadKey(threadRef);
          const selectionState = useThreadSelectionStore.getState();
          if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
            await handleMultiSelectContextMenu(position);
            return;
          }
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return;
          const threadWorkspacePath =
            thread.worktreePath ??
            projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
            null;
          const configLoaded = serverConfigs.has(thread.environmentId);
          const supportsAutoSettleOptOut =
            serverConfigs.get(thread.environmentId)?.environment.capabilities
              .threadAutoSettleOptOut === true;
          const isRegeneratingTitle = thread.titleRegeneration != null;
          const isSettled = settledThreadKeysRef.current.has(threadKey);
          const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
          const isPinned = thread.pinnedAt != null;
          const snoozePresets = resolveSnoozePresets(
            new Date(),
            timestampFormat,
            thread.environmentId,
          );
          const threadProjectGroup =
            projectGroupsRef.current.find((project) =>
              project.memberProjectRefs.some(
                (projectRef) =>
                  projectRef.environmentId === thread.environmentId &&
                  projectRef.projectId === thread.projectId,
              ),
            ) ?? null;
          const clicked = await settlePromise(() =>
            api.contextMenu.show(
              buildThreadActionMenuItems({
                canOperate: readEnvironmentScope(
                  threadRef.environmentId,
                  AuthOrchestrationOperateScope,
                ),
                branch: thread.branch ?? null,
                // An archived project is not a filter choice.
                projectFilter:
                  threadProjectGroup && !threadProjectGroup.archived
                    ? {
                        label: threadProjectGroup.displayName,
                        isActive: projectScopeKeys.includes(threadProjectGroup.projectKey),
                      }
                    : null,
                isPinned,
                isSettled,
                autoSettleEnabled: thread.autoSettleDisabledAt == null,
                isSnoozed,
                canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
                isRegeneratingTitle,
                isRunning: !threadRuntimeCanArchive(thread.runtime),
                canShareWithGuest: appAtomRegistry.get(
                  canShareWithGuestAtom(threadRef.environmentId),
                ),
                canTurnIntoProject: canTurnThreadIntoProject(threadRef),
                supports: {
                  settlement: configLoaded,
                  autoSettleOptOut: supportsAutoSettleOptOut,
                  snooze: configLoaded,
                  pinning: configLoaded,
                  titleRegeneration: configLoaded,
                },
                snoozePresets,
              }),
              position,
            ),
          );
          if (clicked._tag === "Failure" || clicked.value === null) return;
          if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
          if (clicked.value?.startsWith("snooze:")) {
            const preset =
              clicked.value === "snooze:custom"
                ? await requestCustomSnooze()
                : pickSnoozePreset(
                    snoozePresets,
                    clicked.value.slice("snooze:".length),
                    timestampFormat,
                    thread.environmentId,
                  );
            if (preset) attemptSnooze(threadRef, preset);
            return;
          }
          switch (clicked.value) {
            case "filter-by-project":
              if (threadProjectGroup) {
                setProjectScopeKeys(
                  projectScopeKeys.includes(threadProjectGroup.projectKey)
                    ? []
                    : [threadProjectGroup.projectKey],
                );
              }
              return;
            case "project-settings":
              if (threadProjectGroup)
                openProjectSettings(threadProjectGroup, {
                  environmentId: threadRef.environmentId,
                  projectId: thread.projectId,
                });
              return;
            case "new-thread-on-branch": {
              const result = await settlePromise(() =>
                handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
                  branch: thread.branch,
                  worktreePath: thread.worktreePath,
                  envMode: thread.worktreePath ? "worktree" : "local",
                  startFromOrigin: false,
                }),
              );
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Could not create thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            case "settle":
              attemptSettle(threadRef);
              return;
            case "unsettle":
              attemptUnsettle(threadRef);
              return;
            case "unsnooze":
              attemptUnsnooze(threadRef);
              return;
            case "pin":
              attemptPin(threadRef);
              return;
            case "unpin":
              attemptUnpin(threadRef);
              return;
            case "turn-into-project": {
              const result = await turnThreadIntoProject(threadRef);
              if (result._tag === "Success") {
                toastManager.add({
                  type: "success",
                  title: "Project created",
                  description: thread.title,
                });
              } else if (!isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Could not turn thread into a project",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            case "auto-settle:enabled":
            case "auto-settle:disabled": {
              const result = await setThreadAutoSettle(
                threadRef,
                clicked.value === "auto-settle:enabled",
              );
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to update auto-settle",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            case "rename":
              startThreadRename(threadRef, thread.title);
              return;
            case "share-guest":
              openGuestShareDialog(threadRef);
              return;
            case "regenerate-title": {
              if (isRegeneratingTitle) return;
              const result = await updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              });
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to regenerate thread title",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
              }
              return;
            }
            case "mark-unread":
              markThreadUnread(threadRef);
              return;
            case "copy-path":
              if (!threadWorkspacePath) {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Path unavailable",
                    description: "This thread does not have a workspace path to copy.",
                  }),
                );
                return;
              }
              copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
              return;
            case "copy-branch":
              if (thread.branch) {
                copyBranchToClipboard(thread.branch, { branch: thread.branch });
              }
              return;
            case "copy-thread":
              void copyThreadReference(
                threadChipCopyTarget(threadRef, thread.title, configuredHostedAppUrl()),
              );
              return;
            case "copy-thread-id":
              copyThreadIdToClipboard(thread.id, { threadId: thread.id });
              return;
            case "archive": {
              if (confirmThreadArchive) {
                const confirmed = await settlePromise(() =>
                  api.dialogs.confirm(`Archive thread "${thread.title}"?`),
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
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: didArchive
                      ? "Thread archived, but navigation failed"
                      : "Failed to archive thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
                return;
              }
              return;
            }
            case "delete": {
              if (confirmThreadDelete) {
                const confirmed = await settlePromise(() =>
                  api.dialogs.confirm(
                    [
                      `Delete thread "${thread.title}"?`,
                      "This permanently clears conversation history for this thread.",
                    ].join("\n"),
                    { variant: "destructive" },
                  ),
                );
                if (confirmed._tag === "Failure" || !confirmed.value) return;
              }
              const result = await deleteThread(threadRef);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Failed to delete thread",
                    description: error instanceof Error ? error.message : "An error occurred.",
                  }),
                );
                return;
              }
              return;
            }
            default:
              return;
          }
        })();
      },
    );

  return { handleDraftContextMenu, handleThreadContextMenu };
}
