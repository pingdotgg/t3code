import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./useCommandPaletteProjectState";
import { useCommandPaletteActionItemsState } from "./useCommandPaletteActionItemsState";

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
import { visibleLinkedThreads } from "@t3tools/client-runtime/state/threads";
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
import { buildThreadRouteParams } from "../../threadRoutes";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
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
import { reportProjectFailure, useProjectPin } from "../../hooks/useProjectGroupUpdate";
import { getLatestThreadForProject, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../../lib/utils";
import { suggestAppAccessForRemote } from "../sourceControlAppAccessToast";
import {
  useAnyEnvironmentHiding,
  useHiddenThreadKeys,
  useEnvironmentThreadRefs,
  useProjects,
  useServerConfigs,
  useVisibleThreadShells,
  waitForProject,
} from "../../state/entities";
export function useCommandPaletteGroupsState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  s2: ReturnType<typeof useCommandPaletteProjectState>,
  s4: ReturnType<typeof useCommandPaletteActionItemsState>,
  }) {
  const { s1, s2, s4 } = params;
  const { setOpen } = props;
  const { linkedThreadSearch, deferredQuery, query, currentView, threads, linkedThreadRefs, hiddenKeys, hidingAnywhere, navigate, environments, projects, updateProject, clientSettings, handleNewThread, createProject, browseEnvironmentId, browseEnvironmentPlatform, currentProjectCwdForBrowse, newProjectFlow, sourceControlDiscovery, newProjectPublishKind, isCreatingNewProject, browseEnvironment, newProjectSubmittingRef, setIsCreatingNewProject, createNewProject, newProjectPublishes, getAddProjectInitialQueryForEnvironment, addProjectCloneFlow, isRemoteProjectLookingUp, setAddProjectCloneFlow, setHighlightedItemValue, setQuery, setBrowseGeneration, setIsRemoteProjectLookingUp, cloneLookupGeneration, nextCloneLookupGeneration, isCurrentCloneLookupGeneration, lookupRepository, isRemoteProjectCloning, setIsRemoteProjectCloning, startProjectClone } = s1;
  const { activeGroups, rootGroups, actionItems, settingsSearchItems } = s4;
  const { projectSearchItems, allThreadItems, threadMessageItems, searchNow } = s2;
    const isLinkedThreadSearch =
      linkedThreadSearch?.linkedThreads !== undefined && deferredQuery === linkedThreadSearch.query;
    const filteredGroups = filterCommandPaletteGroups({
      activeGroups,
      query: deferredQuery,
      isInSubmenu: currentView !== null,
      ...(deferredQuery.trim().length > 0
        ? {
            allOptions: {
              rootGroups,
              nestedItems: buildNestedSearchItems(actionItems, deferredQuery),
            },
          }
        : {}),
      projectSearchItems: projectSearchItems,
      settingsSearchItems,
      threadSearchItems:
        isLinkedThreadSearch && linkedThreadSearch?.linkedThreads
          ? buildLinkedThreadActionItems({
              ...linkedThreadSearch.linkedThreads,
              threads: visibleLinkedThreads(
                linkedThreadSearch.linkedThreads.threads,
                linkedThreadSearch.linkedThreads.environmentId,
                linkedThreadRefs,
                hiddenKeys,
                hidingAnywhere,
              ),
              query: linkedThreadSearch.query,
              icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
              runThread: async (thread) => {
                await navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                });
              },
            })
          : allThreadItems,
      threadMessageItems: isLinkedThreadSearch ? [] : threadMessageItems,
      now: searchNow,
    });

    const handleAddProjectForEnvironment = async (input: {
      readonly environmentId: EnvironmentId;
      readonly rawCwd: string;
      readonly platform: string;
      readonly currentProjectCwd: string | null;
    }) => {
      const environment = environments.find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${environment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }
      const rawCwd = input.rawCwd;

      if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
      if (cwd.length === 0) return;

      const existing = findProjectByPath(
        projects.filter((project) => project.environmentId === input.environmentId),
        cwd,
      );
      if (existing) {
        // Adding an archived project's folder again brings the project back.
        if (existing.archivedAt != null) {
          void updateProject({
            environmentId: existing.environmentId,
            input: { projectId: existing.id, archived: false },
          }).then((result) => reportProjectFailure("Failed to unarchive project", result));
        }
        const latestThread = getLatestThreadForProject(
          threads.filter((thread) => thread.environmentId === existing.environmentId),
          existing.id,
          clientSettings.sidebarThreadSortOrder,
        );
        if (latestThread && latestThread.settledOverride !== "settled") {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          });
        } else {
          const navigationResult = await settlePromise(() =>
            handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
          );
          if (navigationResult._tag === "Failure") {
            const error = squashAtomCommandFailure(navigationResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open project",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
        }
        setOpen(false);
        return;
      }

      if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cannot add project",
            description: "This connection cannot add projects.",
          }),
        );
        return;
      }
      const projectId = newProjectId();
      const createResult = await createProject({
        environmentId: input.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(cwd),
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to add project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(input.environmentId, projectId)),
      );
      if (navigationResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      setOpen(false);
    };

    const handleAddProject = async (rawCwd: string) => {
      if (!browseEnvironmentId) return;
      await handleAddProjectForEnvironment({
        environmentId: browseEnvironmentId,
        rawCwd,
        platform: browseEnvironmentPlatform,
        currentProjectCwd: currentProjectCwdForBrowse,
      });
    };

    const newProjectPublishTargets =
      newProjectFlow === null ? [] : getNewProjectPublishTargets(sourceControlDiscovery.data ?? null);
    const newProjectPublishTarget = getNewProjectPublishTarget(
      newProjectPublishTargets,
      newProjectPublishKind,
    );
    const newProjectName = query.trim();
    const canSubmitNewProject =
      newProjectFlow !== null &&
      newProjectName.length > 0 &&
      !isCreatingNewProject &&
      canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

    async function submitNewProject(): Promise<void> {
      if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
        return;
      }
      newProjectSubmittingRef.current = true;
      setIsCreatingNewProject(true);
      const created = await settlePromise(() =>
        createNewProject({
          environmentId: newProjectFlow.environmentId,
          name: newProjectName,
          publishTo: newProjectPublishes ? newProjectPublishTarget : null,
        }),
      );
      newProjectSubmittingRef.current = false;
      setIsCreatingNewProject(false);
      if (created._tag === "Failure") throw squashAtomCommandFailure(created);
      if (created.value) setOpen(false);
    }

    function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
      return getAddProjectInitialQueryForEnvironment(environmentId);
    }

    async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
      if (!addProjectCloneFlow) {
        return;
      }
      if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Environment unavailable",
            description: `${browseEnvironment?.label ?? "The selected environment"} is not connected.`,
          }),
        );
        return;
      }

      if (addProjectCloneFlow.step === "repository") {
        const rawRepository = query.trim();
        if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
          return;
        }

        const incompleteOwnerMessage = githubIncompleteOwnerRepositoryMessage(
          addProjectCloneFlow.source,
          rawRepository,
        );
        if (incompleteOwnerMessage) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Repository name incomplete",
              description: incompleteOwnerMessage,
            }),
          );
          return;
        }

        const provider = addProjectRemoteSourceProvider(addProjectCloneFlow.source);
        if (!provider) {
          const destinationPath = getCloneDestinationPath(
            getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
            getCloneDirectoryName(rawRepository),
          );
          setAddProjectCloneFlow({
            step: "confirm",
            environmentId: addProjectCloneFlow.environmentId,
            source: addProjectCloneFlow.source,
            repositoryInput: rawRepository,
            repository: null,
            remoteUrl: normalizePastedCloneUrl(rawRepository),
          });
          setHighlightedItemValue(null);
          setQuery(destinationPath);
          setBrowseGeneration((generation) => generation + 1);
          return;
        }

        setIsRemoteProjectLookingUp(true);
        const lookupGeneration = nextCloneLookupGeneration();
        const lookupResult = await lookupRepository({
          environmentId: addProjectCloneFlow.environmentId,
          input: {
            provider,
            repository: rawRepository,
          },
        });
        if (!isCurrentCloneLookupGeneration(lookupGeneration)) return;
        setIsRemoteProjectLookingUp(false);
        if (lookupResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(lookupResult)) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Repository lookup failed",
                description: errorMessage(squashAtomCommandFailure(lookupResult)),
              }),
            );
          }
          return;
        }
        const repository = lookupResult.value;
        const destinationPath = getCloneDestinationPath(
          getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
          getCloneDirectoryName(repository.nameWithOwner),
        );
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository,
          remoteUrl: getDefaultCloneUrl(repository),
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }

      const rawDestination = (destinationPathInput ?? query).trim();
      if (
        !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthSourceControlWriteScope) ||
        !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthOrchestrationOperateScope)
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone unavailable",
            description: "This connection needs permission to write source control and add projects.",
          }),
        );
        return;
      }
      if (rawDestination.length === 0 || isRemoteProjectCloning) return;

      if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: "Windows-style paths are only supported on Windows.",
          }),
        );
        return;
      }

      if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: "Relative paths require an active project.",
          }),
        );
        return;
      }

      const destinationPath = resolveProjectPathForDispatch(
        rawDestination,
        currentProjectCwdForBrowse,
      );
      if (destinationPath.length === 0) {
        return;
      }

      const projectId = newProjectId();
      setIsRemoteProjectCloning(true);
      const startResult = await startProjectClone({
        environmentId: addProjectCloneFlow.environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(destinationPath),
          // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
          createdAt: new Date().toISOString(),
          remoteUrl: addProjectCloneFlow.remoteUrl,
          destinationPath,
        },
      });
      setIsRemoteProjectCloning(false);
      if (startResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(startResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Clone failed",
              description: errorMessage(squashAtomCommandFailure(startResult)),
            }),
          );
        }
        return;
      }
      setOpen(false);
      void suggestAppAccessForRemote(
        addProjectCloneFlow.environmentId,
        addProjectCloneFlow.remoteUrl,
      );
      const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
      await waitForProject(projectRef, 3_000).catch(() => null);
      const navigationResult = await settlePromise(() => handleNewThread(projectRef));
      if (navigationResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigationResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    }

  return { isLinkedThreadSearch, filteredGroups, handleAddProjectForEnvironment, handleAddProject, newProjectPublishTargets, newProjectPublishTarget, newProjectName, canSubmitNewProject, submitNewProject, submitAddProjectCloneFlow };
}
