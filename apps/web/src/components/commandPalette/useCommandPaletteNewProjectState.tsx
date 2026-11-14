import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./useCommandPaletteProjectState";
import { useCommandPaletteAddProjectState } from "./useCommandPaletteAddProjectState";
import { useCommandPaletteGroupsState } from "./useCommandPaletteGroupsState";

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
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../../lib/utils";
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
import {
  ArrowLeftIcon,
  BugIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronRightIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCcwIcon,
  SettingsIcon,
  MonitorIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TextSearchIcon,
  UserPlusIcon,
} from "lucide-react";
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
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "../CommandPaletteAddProject";
import { Checkbox } from "../ui/checkbox";
export function useCommandPaletteNewProjectState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  s2: ReturnType<typeof useCommandPaletteProjectState>,
  s3: ReturnType<typeof useCommandPaletteAddProjectState>,
  s5: ReturnType<typeof useCommandPaletteGroupsState>,
  }) {
  const { s1, s2, s3, s5 } = params;
  const { pinnedCloneDirectoryName, browsePath, browseEnvironmentPlatform, query, browseNavigation, prefetchBrowsePath, setHighlightedItemValue, setQuery, setBrowseGeneration, browseResult, exactBrowseEntry, relativePathNeedsActiveProject, visibleBrowseEntries, newProjectFlow, dispatchSearch, setNewProjectFlow, setAddProjectEnvironmentId, environmentLabelById, isCreatingNewProject, setNewProjectPublishKind, newProjectPublishes, setNewProjectPublishes, addProjectCloneFlow, isBrowsing } = s1;
  const { newProjectsRootFor, popView } = s2;
  const { newProjectName, newProjectPublishTarget, newProjectPublishTargets, filteredGroups } = s5;
  const { startAddProjectSourceSelection, newProjectEnvironmentOptions, buildEnvironmentItem } = s3;
    const browseTo = async (name: string): Promise<void> => {
      const nextQuery = pinnedCloneDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: browsePath.directoryPath,
            selectedDirectoryName: name,
            cloneDirectoryName: pinnedCloneDirectoryName,
            caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
          })
        : appendBrowsePathSegment(query, name);
      await browseNavigation.run(
        () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
        () => {
          setHighlightedItemValue(null);
          setQuery(nextQuery);
          setBrowseGeneration((generation) => generation + 1);
        },
      );
    };

    const browseUp = async (): Promise<void> => {
      const parentPath = browsePath.parentPath;
      if (parentPath === null) {
        return;
      }

      const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
      await browseNavigation.run(
        () => prefetchBrowsePath(parentPath),
        () => {
          setHighlightedItemValue(null);
          setQuery(nextQuery);
          setBrowseGeneration((generation) => generation + 1);
        },
      );
    };

    const resolvedAddProjectPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? query.trim())
      : (exactBrowseEntry?.fullPath ?? query.trim());

    const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

    const browseGroups = buildBrowseGroups({
      browseEntries: visibleBrowseEntries,
      browseQuery: query,
      canBrowseUp,
      upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
      directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
      browseUp,
      browseTo,
    });
    const cloneDestinationBrowseGroups = browseGroups.map((group) =>
      group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
    );

    const newProjectsRoot = newProjectFlow ? newProjectsRootFor(newProjectFlow.environmentId) : null;
    const newProjectPathPreview =
      newProjectsRoot === null ? null : getNewProjectPathPreview(newProjectsRoot, newProjectName);
    const newProjectPublishToggleValue = "new-project:publish";
    const showExistingProjectSources = (environmentId: EnvironmentId) => {
      const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
      if (sourcesEnvironmentId === environmentId) {
        popView();
        return;
      }
      if (sourcesEnvironmentId !== null) {
        dispatchSearch({ type: "back" });
      }
      popView();
      startAddProjectSourceSelection(environmentId);
    };
    const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
      setNewProjectFlow((flow) => (flow === null ? flow : { ...flow, environmentId }));
      setAddProjectEnvironmentId(environmentId);
    };
    const selectedNewProjectEnvironment =
      newProjectFlow === null
        ? undefined
        : newProjectEnvironmentOptions.find(
            (option) => option.environmentId === newProjectFlow.environmentId,
          );
    const showNewProjectMachines =
      newProjectFlow !== null &&
      (newProjectEnvironmentOptions.length > 1 ||
        (selectedNewProjectEnvironment === undefined && newProjectEnvironmentOptions.length > 0));
    const newProjectEnvironmentLabel = showNewProjectMachines
      ? (selectedNewProjectEnvironment?.label ??
        environmentLabelById.get(newProjectFlow.environmentId) ??
        null)
      : null;
    const newProjectMachineGroup: CommandPaletteView["groups"][number] | null =
      !showNewProjectMachines || newProjectFlow === null
        ? null
        : {
            value: "new-project-machines",
            label: "Environments",
            items: newProjectEnvironmentOptions.map((option) => ({
              ...buildEnvironmentItem(
                option,
                `new-project:environment:${option.environmentId}`,
                switchNewProjectEnvironment,
              ),
              ...(isCreatingNewProject ? { disabled: true } : {}),
              ...(option.environmentId === newProjectFlow.environmentId
                ? {
                    titleTrailingContent: (
                      <CheckIcon className="ms-auto size-4 shrink-0 text-muted-foreground/70" />
                    ),
                  }
                : {}),
            })),
          };
    const newProjectExistingGroup: CommandPaletteView["groups"][number] | null =
      newProjectFlow === null
        ? null
        : {
            value: "new-project-existing",
            label: "",
            items: [
              {
                kind: "action",
                value: "new-project:existing",
                searchTerms: [],
                title: "Add existing project",
                description: "Open a folder or clone a repository",
                icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
                titleTrailingContent: (
                  <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
                ),
                keepOpen: true,
                run: async () => {
                  showExistingProjectSources(newProjectFlow.environmentId);
                },
              },
            ],
          };
    const newProjectOptionGroups: CommandPaletteView["groups"] =
      newProjectPublishTarget === null || newProjectPathPreview === null
        ? []
        : [
            {
              value: "new-project-options",
              label: "Options",
              items: [
                {
                  kind: "action",
                  value: newProjectPublishToggleValue,
                  searchTerms: [],
                  title:
                    newProjectPublishTargets.length > 1
                      ? "Create private repository"
                      : `Create private repository on ${newProjectPublishTarget.definition.label}`,
                  description:
                    newProjectName.length > 0
                      ? getNewProjectRepository(newProjectPublishTarget, newProjectPathPreview)
                      : (newProjectPublishTarget.owner ??
                        `Your ${newProjectPublishTarget.definition.label} account`),
                  icon: sourceControlHostIcon(newProjectPublishTarget.definition, ITEM_ICON_CLASS),
                  titleTrailingContent: (
                    <span className="ms-auto flex items-center gap-2">
                      {newProjectPublishTargets.length > 1 ? (
                        <NewProjectPublishHostPicker
                          disabled={isCreatingNewProject}
                          targets={newProjectPublishTargets}
                          value={newProjectPublishTarget.definition.kind}
                          onValueChange={setNewProjectPublishKind}
                        />
                      ) : null}
                      <span className="pointer-events-none flex">
                        <Checkbox checked={newProjectPublishes} tabIndex={-1} aria-hidden />
                      </span>
                    </span>
                  ),
                  ...(isCreatingNewProject ? { disabled: true } : {}),
                  keepOpen: true,
                  run: async () => {
                    setNewProjectPublishes((publishes) => !publishes);
                  },
                },
              ],
            },
          ];

    let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
    if (newProjectFlow !== null) {
      displayedGroups = [
        ...(newProjectMachineGroup ? [newProjectMachineGroup] : []),
        ...newProjectOptionGroups,
        ...(newProjectExistingGroup ? [newProjectExistingGroup] : []),
      ];
    } else if (addProjectCloneFlow?.step === "repository") {
      displayedGroups = [];
    } else if (addProjectCloneFlow?.step === "confirm") {
      displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
    } else if (isBrowsing) {
      displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
    }

  return { browseTo, browseUp, resolvedAddProjectPath, newProjectsRoot, newProjectPathPreview, newProjectPublishToggleValue, newProjectEnvironmentLabel, displayedGroups };
}
