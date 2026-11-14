import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./useCommandPaletteProjectState";
import { useCommandPaletteGroupsState } from "./useCommandPaletteGroupsState";
import { useCommandPaletteNewProjectState } from "./useCommandPaletteNewProjectState";

import {
  resolveCommandPaletteProject,
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildRootGroups,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  newThreadNoProjectIndex,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteReturnContext,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  buildNestedSearchItems,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  createCommandPaletteSearchState,
  type CommandPaletteGroup,
  resolveAddProjectEntry,
  type AddProjectCloneFlow,
  type AddProjectEnvironmentOption,
  buildPaletteRemoteSourceReadiness,
  errorMessage,
  getEnvironmentBrowsePlatform,
  remoteProjectInputPlaceholder,
  reduceCommandPaletteSearchState,
  type SearchOverlayMode,
} from "../CommandPalette.logic";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  type DesktopWslState,
  type EnvironmentId,
  type FilesystemBrowseResult,
  SourceControlProviderKind,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getNewProjectPathPreview,
  getNewProjectPublishTarget,
  getNewProjectPublishTargets,
  getNewProjectRepository,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@t3tools/client-runtime/operations/projects";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isScratchProject,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@t3tools/client-runtime/state/projects";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../../lib/utils";
import {
  useDeferredValue,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../../keybindings";
import { openThreadFind } from "../chat/threadFindStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
} from "@t3tools/client-runtime/state/filesystem";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "../CommandPaletteResults";
import { readLocalApi } from "../../localApi";
import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerTarget,
  resolveWslProjectSelection,
} from "../../wslPaths";
import { desktopLocalBackendId } from "../../connection/desktopLocal";
import {
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "../CommandPaletteAddProject";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "../ui/command";
export function useCommandPaletteKeyboardState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  s2: ReturnType<typeof useCommandPaletteProjectState>,
  s5: ReturnType<typeof useCommandPaletteGroupsState>,
  s6: ReturnType<typeof useCommandPaletteNewProjectState>,
  }) {
  const { s1, s2, s5, s6 } = params;
  const { setOpen } = props;
  const { displayedGroups, resolvedAddProjectPath, browseUp, browseTo, newProjectPublishToggleValue } = s6;
  const { isBrowsing, isRemoteProjectCloneFlow, newProjectFlow, addProjectCloneFlow, paletteMode, highlightedItemValue, relativePathNeedsActiveProject, canCreateProject, browseEnvironment, isBrowsePending, browseAccessError, query, browseResult, exactBrowseEntry, isRemoteProjectLookingUp, isRemoteProjectCloning, browseEnvironmentId, primaryEnvironmentId, browseEnvironmentIsDesktopLocal, browseDesktopInstanceId, browseDirectoryPath, currentProjectCwdForBrowse, keybindings, activeThreadReferenceCopyTarget, copyActiveThreadReference, activeThreadKey, supportsThreadFind, visibleBrowseEntries, browsePath, pinnedCloneDirectoryName, setHighlightedItemValue, setQuery, highlightClearedRef, resultListRef, isPickingProjectFolder, setIsPickingProjectFolder, browseEnvironmentPlatform, environments, desktopLocalBootstraps, isCreatingNewProject } = s1;
  const { submitAddProjectCloneFlow, submitNewProject, handleAddProject, handleAddProjectForEnvironment, canSubmitNewProject, isLinkedThreadSearch } = s5;
  const { popView, pushPaletteView, isThreadSearchPending } = s2;
    const resultRows = buildCommandPaletteRows(displayedGroups);
    const autoHighlightsFirstRow =
      !isBrowsing && !isRemoteProjectCloneFlow && newProjectFlow === null;

    const inputPlaceholder =
      newProjectFlow !== null
        ? "Project name"
        : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
          getCommandPaletteInputPlaceholder(paletteMode));
    const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
    const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
    const canWriteSourceControl = useEnvironmentScope(
      addProjectCloneFlow?.environmentId ?? null,
      AuthSourceControlWriteScope,
    );
    const canCreateClonedProject = useEnvironmentScope(
      addProjectCloneFlow?.environmentId ?? null,
      AuthOrchestrationOperateScope,
    );
    const canCloneProject = canWriteSourceControl && canCreateClonedProject;
    const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
    const canSubmitBrowsePath =
      isBrowsing &&
      !relativePathNeedsActiveProject &&
      canCreateProject &&
      (!isCloneDestinationStep || canCloneProject) &&
      canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
    const willCreateProjectPath =
      canSubmitBrowsePath &&
      !isBrowsePending &&
      browseAccessError === null &&
      query.trim().length > 0 &&
      !hasHighlightedBrowseItem &&
      (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
    const useMetaForMod = isMacPlatform(navigator.platform);
    const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
    const submitActionLabel = isCloneDestinationStep
      ? willCreateProjectPath
        ? "Create & Clone"
        : "Clone"
      : willCreateProjectPath
        ? "Create & Add"
        : "Add";
    const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
    const hasHighlightedNewProjectItem = newProjectFlow !== null && highlightedItemValue !== null;
    const createShortcutLabel = hasHighlightedNewProjectItem
      ? `${submitModifierLabel} Enter`
      : "Enter";
    const remoteProjectButtonLabel = addProjectCloneFlow
      ? addProjectCloneFlow.source === "url"
        ? "Continue"
        : "Lookup"
      : null;
    const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
    const canSubmitRemoteProjectFlow =
      addProjectCloneFlow?.step === "repository" &&
      query.trim().length > 0 &&
      canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
      !isRemoteProjectPending;
    const fileManagerName = getLocalFileManagerName(navigator.platform);
    const canOpenProjectFromFileManager =
      isBrowsing &&
      browseEnvironmentId !== null &&
      (browseEnvironmentId === primaryEnvironmentId ||
        (browseEnvironmentIsDesktopLocal && browseDesktopInstanceId !== null)) &&
      typeof window !== "undefined" &&
      window.desktopBridge !== undefined;
    const fileManagerInitialPath = (() => {
      if (!canOpenProjectFromFileManager) {
        return undefined;
      }

      const trimmedQuery = query.trim();
      if (trimmedQuery.length === 0) {
        return undefined;
      }

      const initialPath = hasTrailingPathSeparator(query)
        ? (browseResult?.parentPath ?? trimmedQuery)
        : browseDirectoryPath || trimmedQuery;

      const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
      return resolvedPath.length > 0 ? resolvedPath : undefined;
    })();

    function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
      if (item.disabled) {
        return;
      }

      if (item.kind === "submenu") {
        pushPaletteView(item);
        return;
      }

      if (!item.keepOpen) {
        setOpen(false);
      }

      void item.run().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to run command",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      });
    }

    function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
      return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
      if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
        // Confirming an IME candidate must not submit a path or select a row.
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { modelPickerOpen: false, editableFocus: true },
      });
      if (command === "thread.pin") {
        const highlightedItem = findHighlightedCommandPaletteItem(
          displayedGroups,
          highlightedItemValue ??
            (autoHighlightsFirstRow ? (resultRows.itemValues[0] ?? null) : null),
        );
        if (highlightedItem?.kind === "action" && highlightedItem.pin) {
          event.preventDefault();
          event.stopPropagation();
          highlightedItem.pin.toggle();
          return;
        }
      }
      // Global new-thread handlers ignore shortcuts while the palette is open.
      const isJump = threadJumpIndexFromCommand(command ?? "") !== null;
      const isNewThread =
        !event.nativeEvent.isComposing &&
        event.keyCode !== 229 &&
        (command === "chat.new" ||
          command === "chat.newLocal" ||
          command === "chat.newWithoutProject");
      const matchingItem =
        isJump || isNewThread
          ? displayedGroups
              .flatMap((group) => group.items)
              .find((item) => item.shortcutCommand === command)
          : undefined;
      if (isJump || matchingItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        if (matchingItem) {
          executeItem(matchingItem);
        }
        return;
      }
      if (command === "thread.copyReference") {
        event.preventDefault();
        event.stopPropagation();
        if (activeThreadReferenceCopyTarget === null) return;
        setOpen(false);
        void copyActiveThreadReference();
        return;
      }
      // ChatView ignores shortcuts while the palette is open, so intercept find here.
      if (command === "chat.find" && activeThreadKey !== null && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        if (supportsThreadFind) openThreadFind(activeThreadKey);
        else
          toastManager.add({
            id: "thread-find-unavailable",
            title: "Thread search is unavailable on this server.",
            description: "Update the server to enable it.",
          });
        return;
      }

      if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
        event.preventDefault();
        void submitAddProjectCloneFlow();
        return;
      }

      if (
        newProjectFlow !== null &&
        event.key === "Enter" &&
        (!hasHighlightedNewProjectItem || isPrimaryModifierPressed(event)) &&
        // Enter that confirms an IME composition is part of typing the name.
        !event.nativeEvent.isComposing &&
        event.keyCode !== 229
      ) {
        // Base UI would otherwise also click the highlighted row.
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        void submitNewProject();
        return;
      }

      const shouldSubmitBrowsePath =
        canSubmitBrowsePath &&
        event.key === "Enter" &&
        (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

      if (shouldSubmitBrowsePath) {
        event.preventDefault();
        if (isCloneDestinationStep) {
          void submitAddProjectCloneFlow(resolvedAddProjectPath);
        } else {
          void handleAddProject(resolvedAddProjectPath);
        }
        return;
      }

      if (event.key === "Backspace" && query === "" && isSubmenu) {
        event.preventDefault();
        popView();
        return;
      }

      if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;

      if (event.key === "Tab" && isBrowsing && !relativePathNeedsActiveProject) {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        if (highlightedItemValue === "browse:up") {
          void browseUp();
          return;
        }
        const highlightedEntry = visibleBrowseEntries.find(
          (entry) => `browse:${entry.fullPath}` === highlightedItemValue,
        );
        const completion = highlightedEntry
          ? { name: highlightedEntry.name, isComplete: true }
          : getFilesystemBrowseTabCompletion(visibleBrowseEntries, browsePath.filterQuery);
        if (completion?.isComplete) {
          void browseTo(completion.name);
        } else if (completion && !pinnedCloneDirectoryName) {
          setHighlightedItemValue(null);
          setQuery(`${getBrowseDirectoryPath(query)}${completion.name}`);
        }
        return;
      }

      const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;
      if (
        event.key === "ArrowDown" &&
        highlightClearedRef.current &&
        firstItemValue &&
        !event.nativeEvent.isComposing
      ) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        highlightClearedRef.current = false;
        setHighlightedItemValue(firstItemValue);
        scrollCommandPaletteRowIntoView(
          resultListRef.current,
          resultRows.rowIndexByItemIndex[0] ?? 0,
        );
        return;
      }

      // Virtualization may unmount the highlighted row; handle Enter directly instead of Base UI's click.
      if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        const highlightedItem = findHighlightedCommandPaletteItem(
          displayedGroups,
          highlightedItemValue ?? firstItemValue ?? null,
        );
        if (highlightedItem) {
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          event.preventDefault();
          event.stopPropagation();
          executeItem(highlightedItem);
        }
      }
    }


    const handleOpenProjectFromFileManager = async () => {
      if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
        return;
      }
      const api = readLocalApi();
      if (!api) {
        return;
      }

      setIsPickingProjectFolder(true);
      let pickedPath: string | null = null;
      let desktopWslState: DesktopWslState | null = null;
      try {
        desktopWslState =
          browseEnvironmentId === primaryEnvironmentId && browseEnvironmentPlatform === "Linux"
            ? ((await window.desktopBridge?.getWslState().catch(() => null)) ?? null)
            : null;
        // WSL-only primaries need their pool id from desktop settings; the native picker converts WSL UNC
        // paths.
        const pickerTargetEnvironmentId = resolveProjectPickerTarget({
          browseEnvironmentId,
          primaryEnvironmentId,
          desktopInstanceId: browseDesktopInstanceId,
          wslConfiguration: desktopWslState,
        });
        const pickerOptions = {
          ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
          ...(pickerTargetEnvironmentId ? { targetEnvironmentId: pickerTargetEnvironmentId } : {}),
        };
        pickedPath = await api.dialogs.pickFolder(
          Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
        );
      } catch {
        setIsPickingProjectFolder(false);
        return;
      }
      setIsPickingProjectFolder(false);
      if (!pickedPath) {
        return;
      }
      if (parseWslUncPath(pickedPath)) {
        if (desktopWslState === null) {
          desktopWslState = (await window.desktopBridge?.getWslState().catch(() => null)) ?? null;
        }
        let primaryRunningDistro: string | null = null;
        try {
          primaryRunningDistro =
            window.desktopBridge
              ?.getLocalEnvironmentBootstraps()
              .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
            null;
        } catch {}
        const selection = resolveWslProjectSelection(
          pickedPath,
          applyWslEnvironmentConfiguration(
            environments.flatMap((environment) => {
              const backendId = desktopLocalBackendId(environment.entry.target);
              if (!backendId) {
                return [];
              }

              const bootstrap = desktopLocalBootstraps.find(
                (candidate) => candidate.httpBaseUrl === environment.displayUrl,
              );
              const runningDistro = bootstrap?.runningDistro ?? null;
              return [{ environmentId: environment.environmentId, backendId, runningDistro }];
            }),
            primaryEnvironmentId,
            desktopWslState ?? null,
            primaryRunningDistro,
          ),
        );
        if (!selection) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not add WSL project",
              description: "Start the matching WSL backend, then choose the folder again.",
            }),
          );
          return;
        }
        await handleAddProjectForEnvironment({
          environmentId: selection.environmentId,
          rawCwd: selection.linuxPath,
          platform: "Linux",
          currentProjectCwd: null,
        });
        return;
      }
      await handleAddProject(pickedPath);
    };

    const inputAccessory =
      newProjectFlow !== null ? (
        <CommandPaletteSubmitButton
          label={isCreatingNewProject ? "Creating" : "Create"}
          shortcutLabel={createShortcutLabel}
          ariaLabel={`Create (${createShortcutLabel})`}
          tooltip={`Create (${createShortcutLabel})`}
          disabled={!canSubmitNewProject}
          onSubmit={() => {
            void submitNewProject();
          }}
        />
      ) : addProjectCloneFlow?.step === "repository" ? (
        <CommandPaletteSubmitButton
          label={isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}
          shortcutLabel="Enter"
          ariaLabel={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
          tooltip={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
          disabled={!canSubmitRemoteProjectFlow}
          onSubmit={() => {
            void submitAddProjectCloneFlow();
          }}
        />
      ) : isBrowsing ? (
        <CommandPaletteSubmitButton
          label={isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
          shortcutLabel={addShortcutLabel}
          ariaLabel={`${submitActionLabel} (${addShortcutLabel})`}
          tooltip={
            isCloneDestinationStep && !canCloneProject
              ? "This connection needs permission to write source control and add projects."
              : canCreateProject
                ? `${submitActionLabel} (${addShortcutLabel})`
                : "This connection cannot add projects."
          }
          disabled={
            !canCreateProject ||
            !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
            relativePathNeedsActiveProject ||
            (isCloneDestinationStep && (!canCloneProject || isRemoteProjectPending))
          }
          onSubmit={() => {
            if (relativePathNeedsActiveProject) {
              return;
            }
            if (isCloneDestinationStep) {
              void submitAddProjectCloneFlow(resolvedAddProjectPath);
            } else {
              void handleAddProject(resolvedAddProjectPath);
            }
          }}
        />
      ) : null;

    const footerActionLabel =
      newProjectFlow !== null
        ? highlightedItemValue === null
          ? "Create"
          : highlightedItemValue === newProjectPublishToggleValue
            ? "Toggle"
            : "Select"
        : addProjectCloneFlow?.step === "repository"
          ? (remoteProjectButtonLabel ?? "Continue")
          : !canSubmitBrowsePath || hasHighlightedBrowseItem
            ? "Select"
            : undefined;

    const footerTrailing = canOpenProjectFromFileManager ? (
      <CommandFooterAction
        disabled={isPickingProjectFolder}
        onClick={() => {
          void handleOpenProjectFromFileManager();
        }}
      >
        {`Open in ${fileManagerName}`}
      </CommandFooterAction>
    ) : isThreadSearchPending && !isLinkedThreadSearch && !isBrowsing ? (
      // In the footer, so the list keeps its height while message results may
      // still arrive below it.
      <span className="text-muted-foreground text-xs">Searching messages…</span>
    ) : null;

  return { resultRows, autoHighlightsFirstRow, inputPlaceholder, isSubmenu, hasHighlightedBrowseItem, willCreateProjectPath, hasHighlightedNewProjectItem, handleKeyDown, executeItem, inputAccessory, footerActionLabel, footerTrailing };
}
