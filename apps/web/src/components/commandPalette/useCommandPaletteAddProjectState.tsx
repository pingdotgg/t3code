import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./useCommandPaletteProjectState";

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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  CommandPaletteSubmitButton,
  NewProjectPublishHostPicker,
  NewProjectSummary,
  RemoteRepositorySummary,
  remoteProjectSourceIcon,
  sourceControlHostIcon,
} from "../CommandPaletteAddProject";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

const ADD_PROJECT_ENTRY_GROUP = "add-project";

export function useCommandPaletteAddProjectState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  s2: ReturnType<typeof useCommandPaletteProjectState>,
  }) {
  const { s1, s2 } = params;
  const { setOpen } = props;
  const { startAddProjectBrowse, newProjectsRootFor, startNewProject, openSourceControlSettings, startAddProjectClone, pushPaletteView } = s2;
  const { environments, setAddProjectEnvironmentId, setAddProjectCloneFlow, browseEnvironmentId, sourceControlDiscovery, addProjectEnvironmentOptions, navigate, defaultAddProjectEnvironmentId } = s1;
    const buildAddProjectSourceGroups = (
      environmentId: EnvironmentId,
      readinessBySource: AddProjectRemoteSourceReadiness,
    ): CommandPaletteView["groups"] => {
      const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
        {
          kind: "action",
          value: `action:add-project:${environmentId}:local`,
          searchTerms: ["local", "folder", "directory", "browse"],
          title: "Local folder",
          description: "Browse a folder on disk",
          icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            await startAddProjectBrowse(environmentId);
          },
        },
      ];

      if (newProjectsRootFor(environmentId) !== null) {
        sourceItems.unshift({
          kind: "action",
          value: `action:add-project:${environmentId}:new`,
          searchTerms: ["new project", "create", "empty", "repository", "git init"],
          title: "New project",
          description: "Start a new Git repository from a name",
          icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
          keepOpen: true,
          run: async () => {
            startNewProject(environmentId, environmentId);
          },
        });
      }

      const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
        "url",
        ...sortAddProjectProviderSources(readinessBySource),
      ];

      for (const source of orderedSources) {
        const label = addProjectRemoteSourceLabel(source);
        const title = source === "url" ? "Git URL" : `${label} repository`;
        const description =
          source === "url"
            ? "Clone from a remote URL"
            : `Clone ${label} ${addProjectRemoteSourcePathHint(source)}`;
        const readiness = readinessBySource(source);
        const disabledHint = readiness.hint;

        const titleTrailingContent = readiness.ready ? undefined : (
          <span className="ml-auto">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="warning-outline"
                    size="micro"
                    onClick={() => {
                      openSourceControlSettings();
                    }}
                  >
                    Setup Required
                  </Button>
                }
              />
              <TooltipPopup align="end" side="left">
                {disabledHint ?? "Open Settings -> Source control to configure this provider."}
              </TooltipPopup>
            </Tooltip>
          </span>
        );

        if (!readiness.ready) {
          sourceItems.push({
            kind: "action",
            value: `action:add-project:${environmentId}:${source}:not-ready`,
            searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
            title,
            description,
            disabled: true,
            icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
            ...(titleTrailingContent ? { titleTrailingContent } : {}),
            run: async () => {},
          });
          continue;
        }

        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label],
          title,
          description,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          keepOpen: true,
          run: async () => {
            startAddProjectClone(environmentId, source);
          },
        });
      }

      return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
    };

    const startAddProjectSourceSelection = (environmentId: EnvironmentId): void => {
      const environment = environments.find((candidate) => candidate.environmentId === environmentId);
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
      setAddProjectEnvironmentId(environmentId);
      setAddProjectCloneFlow(null);
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildPaletteRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
          ),
        ),
      });
    };

    const buildEnvironmentItem = (
      option: AddProjectEnvironmentOption,
      value: string,
      run: (environmentId: EnvironmentId) => void,
    ): CommandPaletteActionItem => ({
      kind: "action",
      value,
      searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
      title: option.label,
      description: option.isConnected
        ? option.isPrimary
          ? "This device"
          : option.environmentId
        : option.status,
      disabled: !option.isConnected,
      icon: <EnvironmentMachineIcon kind={option.machine} className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        run(option.environmentId);
      },
    });
    const addProjectEnvironmentItems = addProjectEnvironmentOptions.map((option) =>
      buildEnvironmentItem(
        option,
        `action:add-project:environment:${option.environmentId}`,
        startAddProjectSourceSelection,
      ),
    );
    const newProjectEnvironmentOptions = addProjectEnvironmentOptions.filter(
      (option) => option.isConnected && newProjectsRootFor(option.environmentId) !== null,
    );

    const addProjectEnvironmentGroups = [
      {
        value: "environments",
        label: "Environments",
        items: addProjectEnvironmentItems,
      },
    ];

    const openConnectionSettings = () => {
      setOpen(false);
      void navigate({ to: "/settings/connections" });
    };
    const addProjectEntry = resolveAddProjectEntry(
      addProjectEnvironmentOptions,
      defaultAddProjectEnvironmentId,
    );

    const openAddProjectFlow = () => {
      switch (addProjectEntry.kind) {
        case "connect-environment":
          openConnectionSettings();
          return;
        case "choose-environment":
          pushPaletteView({
            addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
            groups: addProjectEnvironmentGroups,
          });
          return;
        case "choose-source":
          startAddProjectSourceSelection(addProjectEntry.environmentId);
          return;
      }
    };

    // The view an "Add project" intent opens to follows the environments as they
    // connect, so it resolves here instead of being fixed when the palette opened.
    const addProjectEntryGroups = (): ReadonlyArray<CommandPaletteGroup> => {
      switch (addProjectEntry.kind) {
        case "connect-environment":
          return [
            {
              value: ADD_PROJECT_ENTRY_GROUP,
              label: "",
              items: [
                {
                  kind: "action",
                  value: "action:add-project:connect-environment",
                  searchTerms: ["connect", "environment", "connection", "settings"],
                  title: "Connect an environment",
                  description: "No connected environment can add a project",
                  icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
                  keepOpen: true,
                  run: async () => {
                    openConnectionSettings();
                  },
                },
              ],
            },
          ];
        case "choose-environment":
          return addProjectEnvironmentGroups;
        case "choose-source":
          return buildAddProjectSourceGroups(
            addProjectEntry.environmentId,
            buildPaletteRemoteSourceReadiness(
              browseEnvironmentId === addProjectEntry.environmentId
                ? sourceControlDiscovery.data
                : null,
            ),
          );
      }
    };

    const openNewProjectFlow = () => {
      const firstOption = newProjectEnvironmentOptions[0];
      if (firstOption) startNewProject(firstOption.environmentId, null);
    };

  return { buildAddProjectSourceGroups, startAddProjectSourceSelection, buildEnvironmentItem, newProjectEnvironmentOptions, openAddProjectFlow, addProjectEntryGroups, openNewProjectFlow };
}
