import type { CommandPaletteDialogProps } from "./commandPaletteTypes";
import { useCommandPaletteBrowseState } from "./useCommandPaletteBrowseState";
import { useCommandPaletteProjectState } from "./useCommandPaletteProjectState";
import { useCommandPaletteAddProjectState } from "./useCommandPaletteAddProjectState";

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
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../../lib/chatThreadActions";
import { openThreadFind } from "../chat/threadFindStore";
import {
  composerPromptLink,
  copyPromptLink,
  promptLinkRepositoryOf,
} from "../promptLinks/copyPromptLink";import { threadPullRequestLinkMode } from "@t3tools/client-runtime/thread-pull-request-compatibility";

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { openLinkPullRequestDialog } from "../pullRequest/LinkPullRequestDialog";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../../rightPanelStore";
import { openGuestShareDialog } from "../chat/guestShareDialogState";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";
import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../../lib/workspaceFocus";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "../settings/settingsSearch";

const ADD_PROJECT_ENTRY_GROUP = "add-project";

const NEW_THREAD_IN_GROUP = "projects";

export function useCommandPaletteActionItemsState(props: CommandPaletteDialogProps, params: {
  s1: ReturnType<typeof useCommandPaletteBrowseState>,
  s2: ReturnType<typeof useCommandPaletteProjectState>,
  s3: ReturnType<typeof useCommandPaletteAddProjectState>,
  }) {
  const { s1, s2, s3 } = params;
  const { openChildSearch } = props;
  const { projects, projectPickerEntries, currentProject, activeDraftThread, activeThread, defaultProjectRef, handleNewThread, scratchTargetEnvironmentId, startScratchThread, triageEnvironmentId, canTriage, startTriage, activeThreadKey, supportsThreadFind, paletteRouteTarget, providersByEnvironment, activeThreadReferenceCopyTarget, copyActiveThreadReference, activeThreadServerConfig, canShareActiveThreadWithGuest, stopThreadSession, projectByKey, refreshProviders, query, linkedThreadSearch, wslAddProjectEnvironmentOption, changeThemeItem, changeAppearanceItem, themeEditorItem, environments, navigate, contextualProjectRef, projectGroups, canPinProjectGroup, toggleProjectGroupPin, availableSettingsSearchItems, pathname, addProjectEnvironmentId, currentView, sourceControlDiscovery } = s1;
  const { projectThreadItems, startAddProjectBrowse, recentThreadItems } = s2;
  const { newProjectEnvironmentOptions, openNewProjectFlow, openAddProjectFlow, buildAddProjectSourceGroups, addProjectEntryGroups } = s3;
    const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

    if (projects.length > 0) {
      const activeProjectTitle =
        projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
        currentProject?.title ??
        null;

      if (activeProjectTitle) {
        actionItems.push({
          kind: "action",
          value: "action:new-thread",
          searchTerms: ["new thread", "chat", "create", "draft"],
          title: (
            <>
              New thread in <span className="font-semibold">{activeProjectTitle}</span>
            </>
          ),
          searchTitle: `New thread in ${activeProjectTitle}`,
          icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "chat.newLocal",
          run: async () => {
            await startNewThreadFromContext({
              activeDraftThread,
              activeThread: activeThread ?? undefined,
              defaultProjectRef,
              handleNewThread,
            });
          },
        });
      }

      actionItems.push({
        kind: "submenu",
        value: "action:new-thread-in",
        searchTerms: ["new thread", "project", "pick", "choose", "select"],
        title: "New thread in...",
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: NEW_THREAD_IN_GROUP, label: "Projects", items: projectThreadItems }],
      });
    }

    if (scratchTargetEnvironmentId !== null) {
      actionItems.push({
        kind: "action",
        value: "action:new-thread-without-project",
        searchTerms: ["new thread", "no project", "without project", "none", "chat"],
        title: "New thread without a project",
        icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newWithoutProject",
        run: () => startScratchThread(scratchTargetEnvironmentId),
      });
    }

    if (triageEnvironmentId !== null && canTriage) {
      actionItems.push({
        kind: "action",
        value: "action:triage",
        searchTerms: ["triage", "bug", "issue", "report", "broken", "debug", "help", "support"],
        title: "Triage an issue",
        description: "An agent investigates a T3 Code problem and helps file an issue",
        icon: <BugIcon className={ITEM_ICON_CLASS} />,
        run: () => startTriage(triageEnvironmentId),
      });
    }

    if (activeThreadKey !== null && supportsThreadFind) {
      actionItems.push({
        kind: "action",
        value: "find-current-thread",
        title: "Find in current thread",
        searchTerms: ["find", "search", "messages", "plans"],
        icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.find",
        run: async () => {
          openThreadFind(activeThreadKey);
        },
      });
    }

    const promptLinkTarget = paletteRouteTarget
      ? paletteRouteTarget.kind === "server"
        ? paletteRouteTarget.threadRef
        : paletteRouteTarget.draftId
      : null;
    const promptLinkProjectRef = activeThread ?? activeDraftThread;
    const promptLinkInput =
      promptLinkTarget === null
        ? null
        : {
            target: promptLinkTarget,
            project: projects.find(
              (project) =>
                project.environmentId === promptLinkProjectRef?.environmentId &&
                project.id === promptLinkProjectRef.projectId,
            ),
            providers:
              (promptLinkProjectRef
                ? providersByEnvironment.get(promptLinkProjectRef.environmentId)
                : undefined) ?? [],
            threadModelSelection: activeThread?.modelSelection ?? null,
          };
    const plainPromptLink = promptLinkInput
      ? composerPromptLink({ ...promptLinkInput, withContext: false })
      : null;
    if (promptLinkInput !== null && plainPromptLink !== null) {
      actionItems.push({
        kind: "action",
        value: "action:copy-prompt-link",
        searchTerms: ["copy", "share", "prompt", "link"],
        title: "Copy prompt link",
        icon: <LinkIcon className={ITEM_ICON_CLASS} />,
        run: () => copyPromptLink(plainPromptLink),
      });
      if (promptLinkRepositoryOf(promptLinkInput.project) !== null) {
        const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
        if (contextLink !== null) {
          actionItems.push({
            kind: "action",
            value: "action:copy-prompt-link-with-context",
            searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
            title: "Copy prompt link with repo and model",
            icon: <LinkIcon className={ITEM_ICON_CLASS} />,
            run: () => copyPromptLink(contextLink),
          });
        }
      }
    }

    if (activeThreadReferenceCopyTarget !== null) {
      actionItems.push({
        kind: "action",
        value: "action:copy-thread-reference",
        searchTerms:
          activeThreadReferenceCopyTarget.kind === "pull-request"
            ? ["copy", "pull request", "link", "reference"]
            : ["copy", "thread", "thread id", "reference"],
        title:
          activeThreadReferenceCopyTarget.kind === "pull-request" ? "Copy PR link" : "Copy thread",
        description: activeThreadReferenceCopyTarget.description,
        icon: <LinkIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "thread.copyReference",
        run: copyActiveThreadReference,
      });
    }

    if (
      activeThread !== null &&
      threadPullRequestLinkMode(activeThreadServerConfig?.environment.capabilities) !== "unsupported"
    ) {
      const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
      actionItems.push({
        kind: "action",
        value: "action:link-pull-request",
        searchTerms: ["link", "pull request", "pr", "attach", "stack"],
        title: "Link pull request to thread",
        icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
        run: async () => {
          openLinkPullRequestDialog(threadRef);
        },
      });
      actionItems.push({
        kind: "action",
        value: "action:open-thread-pull-requests",
        searchTerms: ["pull requests", "linked", "stack", "prs"],
        title: "Show linked pull requests",
        disabled: visibleThreadPullRequests(activeThread.pullRequests).length === 0,
        icon: <PullRequestGlyph.link className={ITEM_ICON_CLASS} />,
        run: async () => {
          useRightPanelStore.getState().open(threadRef, "pull-requests");
        },
      });
    }

    if (activeThread !== null && canShareActiveThreadWithGuest) {
      const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
      actionItems.push({
        kind: "action",
        value: "action:share-thread-with-guest",
        searchTerms: ["share", "guest", "invite", "link", "teammate"],
        title: "Share with guest",
        icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          openGuestShareDialog(threadRef);
        },
      });
    }

    if (activeThread !== null) {
      const thread = activeThread;
      actionItems.push({
        kind: "action",
        value: "action:restart-agent-session",
        searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
        title: "Restart agent session",
        icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          const { environmentId } = thread;
          if (thread.runtime !== null) {
            const stopped = await stopThreadSession({
              environmentId,
              input: { threadId: thread.id },
            });
            if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
          }
          toastManager.add({
            type: "success",
            title: "Agent session will restart",
            description: "Your next message starts a fresh session.",
          });
          const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
          if (!project) return;
          const refreshed = await refreshProviders({
            environmentId,
            input: {
              instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
              cwd: thread.worktreePath ?? project.workspaceRoot,
              fresh: true,
            },
          });
          if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
        },
      });
    }

    actionItems.push({
      kind: "action",
      value: "action:open-file-picker",
      searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
      title: "Go to file",
      icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      shortcutCommand: "filePicker.toggle",
      run: async () => {
        openChildSearch("files", { query, linkedThreadSearch });
      },
    });

    actionItems.push({
      kind: "action",
      value: "action:search-project-contents",
      searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
      title: "Search project contents",
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      shortcutCommand: "projectSearch.toggle",
      run: async () => {
        openChildSearch("content", { query, linkedThreadSearch });
      },
    });

    if (newProjectEnvironmentOptions.length > 0) {
      actionItems.push({
        kind: "action",
        value: "action:new-project",
        searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
        title: "New project",
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          openNewProjectFlow();
        },
      });
    }

    const addProjectAction: CommandPaletteActionItem = {
      kind: "action",
      value: "action:add-project",
      searchTerms: [
        "add project",
        "folder",
        "directory",
        "browse",
        "clone",
        "remote",
        "repository",
        "repo",
        "git",
        ...sourceControlClients.definitions.flatMap((definition) =>
          definition.pickerLabel
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean),
        ),
        "url",
        "environment",
      ],
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openAddProjectFlow();
      },
    };
    actionItems.push(addProjectAction);

    if (wslAddProjectEnvironmentOption) {
      actionItems.push({
        kind: "action",
        value: "action:add-project:wsl-folder",
        searchTerms: ["add project", "open", "wsl", "linux", "folder", "directory"],
        title: "Open WSL folder",
        description: wslAddProjectEnvironmentOption.label,
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          await startAddProjectBrowse(wslAddProjectEnvironmentOption.environmentId);
        },
      });
    }

    actionItems.push(changeThemeItem);
    actionItems.push(changeAppearanceItem);

    actionItems.push(themeEditorItem);

    if (environments.some((environment) => environment.serverConfig !== null)) {
      actionItems.push({
        kind: "action",
        value: "action:pull-requests",
        searchTerms: [
          ...new Set(
            sourceControlClients.definitions.flatMap((definition) => {
              const shortLabel = definition.changeRequest.shortLabel.toLowerCase();
              return [
                definition.changeRequest.plural,
                `${shortLabel}s`,
                shortLabel,
                ...definition.label.toLowerCase().split(/[^a-z0-9]+/u),
              ].filter(Boolean);
            }),
          ),
          "review",
          "merge",
          "branch",
        ],
        title: "Open pull requests",
        icon: <PullRequestGlyph.pullRequest className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
        },
      });
    }

    actionItems.push({
      kind: "action",
      value: "action:usage",
      searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
      title: "Open usage",
      icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "usage.open",
      run: async () => {
        await navigate({ to: "/usage" });
      },
    });

    for (const direction of [1, -1] as const) {
      const title = direction === 1 ? "Focus Next Workspace Area" : "Focus Previous Workspace Area";
      actionItems.push({
        kind: "action",
        value: `action:workspace-focus:${direction}`,
        title,
        searchTerms: [title, "accessibility", "navigation", "focus", "F6"],
        icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: direction === 1 ? "workspace.focusNext" : "workspace.focusPrevious",
        run: async () => {
          queueWorkspaceFocusFromPalette(direction);
        },
      });
    }

    actionItems.push({
      kind: "action",
      value: "action:settings",
      searchTerms: ["settings", "preferences", "configuration", "keybindings"],
      title: "Open settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings" });
      },
    });

    // Every group, so an archived project's thread still opens its own settings.
    const currentProjectGroup =
      (contextualProjectRef
        ? projectGroups.find((group) =>
            group.memberProjectRefs.some(
              (ref) =>
                ref.environmentId === contextualProjectRef.environmentId &&
                ref.projectId === contextualProjectRef.projectId,
            ),
          )
        : null) ?? null;
    if (currentProjectGroup && canPinProjectGroup(currentProjectGroup)) {
      actionItems.push({
        kind: "action",
        value: "action:project-pin",
        searchTerms: ["pin", "unpin", "project", "favorite"],
        title: currentProjectGroup.pinned ? "Unpin project" : "Pin project",
        description: currentProjectGroup.displayName,
        icon: currentProjectGroup.pinned ? (
          <PinOffIcon className={ITEM_ICON_CLASS} />
        ) : (
          <PinIcon className={ITEM_ICON_CLASS} />
        ),
        run: async () => toggleProjectGroupPin(currentProjectGroup),
      });
    }
    const contextualProjectGroup = currentProjectGroup ?? projectGroups[0] ?? null;
    if (contextualProjectGroup) {
      actionItems.push({
        kind: "action",
        value: "action:project-settings",
        searchTerms: [
          "project",
          "settings",
          "name",
          "icon",
          "scripts",
          "model",
          "workspace",
          "grouping",
          "checkout",
          "remove",
          "t3.json",
        ],
        title: "Project settings",
        description: contextualProjectGroup.displayName,
        icon: <FolderIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({
            to: "/projects/$projectKey",
            params: { projectKey: contextualProjectGroup.projectKey },
          });
        },
      });
    }

    const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
    // Every setting goes to the palette's own matcher, so settings get the same
    // word starts and typo tolerance as threads.
    const settingsSearchItems: CommandPaletteActionItem[] = settingsForThisPlatform(
      availableSettingsSearchItems,
    ).map((item) => ({
      kind: "action",
      value: `setting:${item.id}`,
      searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
      title: item.title,
      description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
      ...(item.secondary ? { secondary: true } : {}),
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: item.to,
          hash: item.targetId ?? item.id,
          replace: pathname === item.to,
          hashScrollIntoView: false,
        });
      },
    }));
    const sourceSelectionViewValue =
      addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
    const activeGroups =
      addProjectEnvironmentId !== null &&
      currentView !== null &&
      currentView.groups[0]?.value === sourceSelectionViewValue
        ? buildAddProjectSourceGroups(
            addProjectEnvironmentId,
            buildPaletteRemoteSourceReadiness(sourceControlDiscovery.data),
          )
        : currentView?.groups[0]?.value === ADD_PROJECT_ENTRY_GROUP
          ? addProjectEntryGroups()
          : currentView?.groups[0]?.value === NEW_THREAD_IN_GROUP
            ? [
                {
                  value: NEW_THREAD_IN_GROUP,
                  label: "Projects",
                  // Every project archived and no "No project" home leaves only adding one.
                  items: projectThreadItems.length > 0 ? projectThreadItems : [addProjectAction],
                },
              ]
            : currentView?.groups[0]?.value === "themes"
              ? changeThemeItem.groups
              : currentView?.groups[0]?.value === "appearance"
                ? changeAppearanceItem.groups
                : (currentView?.groups ?? rootGroups);

  return { actionItems, rootGroups, settingsSearchItems, activeGroups };
}
