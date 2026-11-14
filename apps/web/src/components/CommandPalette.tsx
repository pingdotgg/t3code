
import { useCommandPaletteBrowseState } from "./commandPalette/useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./commandPalette/useCommandPaletteProjectState";
import { useCommandPaletteAddProjectState } from "./commandPalette/useCommandPaletteAddProjectState";
import { useCommandPaletteActionItemsState } from "./commandPalette/useCommandPaletteActionItemsState";
import { useCommandPaletteGroupsState } from "./commandPalette/useCommandPaletteGroupsState";
import { useCommandPaletteNewProjectState } from "./commandPalette/useCommandPaletteNewProjectState";
import { useCommandPaletteKeyboardState } from "./commandPalette/useCommandPaletteKeyboardState";
import type { CommandPaletteDialogProps } from "./commandPalette/commandPaletteTypes";

import { type FilesystemBrowseResult } from "@t3tools/contracts";

import { ArrowLeftIcon, FolderPlusIcon, PaletteIcon, SquarePenIcon } from "lucide-react";

import { useRef, type ReactNode } from "react";

import { restoreWorkspaceFocusFromPalette } from "../lib/workspaceFocus";

import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";

import { cn } from "../lib/utils";

import { ADDON_ICON_CLASS, browseInputEndPaddingClass, type CommandPaletteOpenIntent, type CommandPaletteReturnContext, type CommandPaletteView, type SearchOverlayMode } from "./CommandPalette.logic";

import { CommandPaletteContent } from "./CommandPaletteContent";

import { NewProjectSummary, RemoteRepositorySummary } from "./CommandPaletteAddProject";

import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";

import { ProjectFilePicker } from "./files/ProjectFilePicker";

import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";

import { CommandDialog, CommandDialogPopup } from "./ui/command";

import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];
const ADD_PROJECT_ENTRY_GROUP = "add-project";
const NEW_THREAD_IN_GROUP = "projects";

/** The submenu an open intent starts in; its groups resolve while rendering. */
function openIntentView(intent: CommandPaletteOpenIntent | null): CommandPaletteView | null {
  switch (intent?.kind) {
    case "add-project":
      return {
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: ADD_PROJECT_ENTRY_GROUP, label: "", items: [] }],
      };
    case "new-thread-in":
      return {
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: NEW_THREAD_IN_GROUP, label: "Projects", items: [] }],
      };
    case "change-theme":
      return {
        addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "themes", label: "Change theme", items: [] }],
      };
    case "search":
    case undefined:
      return null;
  }
}

const NEW_THREAD_NO_PROJECT_VALUE = "new-thread-in:no-project";

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          session={state.session}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openChildSearch={openChildSearch}
          initialContext={state.restoredSearch}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly session: number;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openChildSearch: (
    mode: "files" | "content",
    context: CommandPaletteReturnContext,
  ) => void;
  readonly initialContext: CommandPaletteReturnContext | undefined;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        if (restoreWorkspaceFocusFromPalette()) return false;
        const returnFocus = getCommandPaletteReturnFocus();
        if (returnFocus === false) return false;
        const composer = composerHandleRef?.current;
        // Behind the Settings modal the composer is inert and cannot take focus.
        if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          key={props.session}
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openChildSearch={props.openChildSearch}
          initialContext={props.initialContext}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: CommandPaletteDialogProps) {
const s1 = useCommandPaletteBrowseState(props);
const { navigate, pathname, openChildSearch, setOpen, linkedThreadSearch, hiddenKeys, hidingAnywhere, linkedThreadRefs, dispatchSearch, query, viewStack, setQuery, deferredQuery, isActionsOnly, highlightedItemValue, setHighlightedItemValue, resultListRef, highlightClearedRef, clearTypedHighlight, clientSettings, createProject, updateProject, scratchWorkspaceRootFor, startScratchThread, startTriage, lookupRepository, startProjectClone, stopThreadSession, refreshProviders, environments, desktopLocalBootstraps, primaryEnvironmentId, availableSettingsSearchItems, activeDraftThread, activeThread, defaultProjectRef, handleNewThread, paletteRouteTarget, projects, activeThreadServerConfig, canShareActiveThreadWithGuest, activeThreadReferenceCopyTarget, copyActiveThreadReference, threads, keybindings, providersByEnvironment, changeThemeItem, changeAppearanceItem, themeEditorItem, currentView, threadSearchQuery, browseGeneration, setBrowseGeneration, browseNavigation, addProjectEnvironmentId, setAddProjectEnvironmentId, isPickingProjectFolder, setIsPickingProjectFolder, addProjectCloneFlow, setAddProjectCloneFlow, newProjectFlow, setNewProjectFlow, newProjectPublishes, setNewProjectPublishes, newProjectPublishKind, setNewProjectPublishKind, isCreatingNewProject, setIsCreatingNewProject, newProjectSubmittingRef, createNewProject, cloneLookupGeneration, isRemoteProjectLookingUp, setIsRemoteProjectLookingUp, isRemoteProjectCloning, setIsRemoteProjectCloning, environmentLabelById, projectEnvironmentLocationById, projectGroups, contextualProjectRef, projectPickerEntries, pickerProjects, projectGroupByTargetKey, canPinProjectGroup, toggleProjectGroupPin, rowOrderKey, projectPin, addProjectEnvironmentOptions, defaultAddProjectEnvironmentId, wslAddProjectEnvironmentOption, browseEnvironmentId, canCreateProject, browseEnvironment, browseEnvironmentIsDesktopLocal, browseDesktopInstanceId, sourceControlDiscovery, browseEnvironmentPlatform, isRemoteProjectCloneFlow, pinnedCloneDirectoryName, canBrowsePaths, browsePath, isBrowsing, browseDirectoryPath, paletteMode, getAddProjectInitialQueryForEnvironment, projectByKey, activeThreadKey, supportsThreadFind, scratchTargetEnvironmentId, triageEnvironmentId, canTriage, currentProject, currentProjectCwdForBrowse, getBrowseCwdForEnvironment, relativePathNeedsActiveProject, browseResult, isBrowsePending, browseAccessError, visibleBrowseEntries, exactBrowseEntry, prefetchBrowsePath } = s1;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the browse navigation coordinator and in-flight clone lookups when the palette session unmounts
const s2 = useCommandPaletteProjectState(props, { s1 });
const { projectSearchItems, projectThreadItems, allThreadItems, threadMessageItems, searchNow, isThreadSearchPending, recentThreadItems, pushPaletteView, popView, handleQueryChange, startAddProjectBrowse, startAddProjectClone, newProjectsRootFor, startNewProject, openSourceControlSettings } = s2;

const s3 = useCommandPaletteAddProjectState(props, { s1, s2 });
const { buildAddProjectSourceGroups, startAddProjectSourceSelection, buildEnvironmentItem, newProjectEnvironmentOptions, openAddProjectFlow, addProjectEntryGroups, openNewProjectFlow } = s3;

const s4 = useCommandPaletteActionItemsState(props, { s1, s2, s3 });
const { actionItems, rootGroups, settingsSearchItems, activeGroups } = s4;

const s5 = useCommandPaletteGroupsState(props, { s1, s2, s4 });
const { isLinkedThreadSearch, filteredGroups, handleAddProjectForEnvironment, handleAddProject, newProjectPublishTargets, newProjectPublishTarget, newProjectName, canSubmitNewProject, submitNewProject, submitAddProjectCloneFlow } = s5;

const s6 = useCommandPaletteNewProjectState(props, { s1, s2, s3, s5 });
const { browseTo, browseUp, resolvedAddProjectPath, newProjectsRoot, newProjectPathPreview, newProjectPublishToggleValue, newProjectEnvironmentLabel, displayedGroups } = s6;
const s7 = useCommandPaletteKeyboardState(props, { s1, s2, s5, s6 });
const { resultRows, autoHighlightsFirstRow, inputPlaceholder, isSubmenu, hasHighlightedBrowseItem, willCreateProjectPath, hasHighlightedNewProjectItem, handleKeyDown, executeItem, inputAccessory, footerActionLabel, footerTrailing } = s7;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${newProjectFlow ? "new-project" : (addProjectCloneFlow?.step ?? "none")}`}
      aria-label="Command palette"
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className: hasHighlightedNewProjectItem
          ? "*:data-[slot=autocomplete-input]:pe-38!"
          : addProjectCloneFlow?.step === "repository" || newProjectFlow !== null
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      {newProjectPathPreview !== null ? (
        <NewProjectSummary
          name={newProjectName}
          pathPreview={newProjectPathPreview}
          projectsRoot={newProjectsRoot}
          environmentLabel={newProjectEnvironmentLabel}
        />
      ) : null}
      {addProjectCloneFlow?.step === "confirm" ? (
        <RemoteRepositorySummary
          source={addProjectCloneFlow.source}
          title={
            addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput
          }
          description={addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl}
        />
      ) : null}
      {browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading folders...
        </div>
      ) : null}
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? "Enter a Git clone URL and press Enter to continue."
                  : "Enter a repository path and press Enter to look it up.",
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: "Choose a destination path and press Enter to clone." }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : isThreadSearchPending
                  ? { emptyStateMessage: "Searching thread messages…" }
                  : {})}
      />
    </CommandPaletteContent>
  );
}
