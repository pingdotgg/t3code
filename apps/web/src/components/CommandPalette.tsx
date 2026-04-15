"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { ProjectId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  Columns2Icon,
  MessageSquareIcon,
  Rows2Icon,
  SettingsIcon,
  SquarePenIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  WORKSPACE_COMMAND_METADATA,
  useWorkspaceCommandExecutor,
} from "../hooks/useWorkspaceCommandExecutor";
import { useSettings } from "../hooks/useSettings";
import {
  startNewThreadInProjectFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { getLatestThreadForProject } from "../lib/threadSort";
import { cn } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useWorkspaceStore, useWorkspaceThreadTerminalOpen } from "../workspace/store";
import { serverThreadSurfaceInput } from "../workspace/types";
import {
  ADDON_ICON_CLASS,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { useServerKeybindings } from "../rpc/serverState";
import { resolveShortcutCommand } from "../keybindings";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { toastManager } from "./ui/toast";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useServerKeybindings();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useWorkspaceThreadTerminalOpen(routeThreadRef);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  return (
    <ComposerHandleContext.Provider value={composerHandleRef}>
      {children}
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandPaletteDialog />
      </CommandDialog>
    </ComposerHandleContext.Provider>
  );
}

function CommandPaletteDialog() {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);

  useEffect(() => {
    return () => {
      setOpen(false);
    };
  }, [setOpen]);

  if (!open) {
    return null;
  }

  return <OpenCommandPaletteDialog />;
}

function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const workspaceTarget = useCommandPaletteStore((store) => store.workspaceTarget);
  const clearWorkspaceTarget = useCommandPaletteStore((store) => store.clearWorkspaceTarget);
  const composerHandleRef = useComposerHandleContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const settings = useSettings();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const keybindings = useServerKeybindings();
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const paletteMode = getCommandPaletteMode({ currentView });
  const { canOpenTerminalSurface, canSplitFocusedPane, executeWorkspaceCommand } =
    useWorkspaceCommandExecutor();
  const openThreadSurface = useWorkspaceStore((state) => state.openThreadSurface);
  const workspaceWindowCount = useWorkspaceStore(
    (state) => Object.keys(state.document.windowsById).length,
  );
  const canUseSpatialWorkspaceCommands = workspaceWindowCount > 1;

  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === project.environmentId),
        project.id,
        settings.sidebarThreadSortOrder,
      );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        envMode: settings.defaultThreadEnvMode,
      });
    },
    [
      handleNewThread,
      navigate,
      settings.defaultThreadEnvMode,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );

  const projectSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "project",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, projects],
  );

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: (project) => (
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.cwd}
            className={ITEM_ICON_CLASS}
          />
        ),
        runProject: async (project) => {
          await startNewThreadInProjectFromContext(
            {
              activeDraftThread,
              activeThread,
              defaultProjectRef,
              defaultThreadEnvMode: settings.defaultThreadEnvMode,
              handleNewThread,
            },
            scopeProjectRef(project.environmentId, project.id),
          );
        },
      }),
    [
      activeDraftThread,
      activeThread,
      defaultProjectRef,
      handleNewThread,
      projects,
      settings.defaultThreadEnvMode,
    ],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: settings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [activeThreadId, navigate, projectTitleById, settings.sidebarThreadSortOrder, threads],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);
  const workspaceTargetThreadItems = useMemo(() => {
    if (!workspaceTarget) {
      return [];
    }

    return buildThreadActionItems({
      threads,
      ...(activeThreadId ? { activeThreadId } : {}),
      projectTitleById,
      sortOrder: settings.sidebarThreadSortOrder,
      icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
      runThread: async (thread) => {
        openThreadSurface(
          serverThreadSurfaceInput(scopeThreadRef(thread.environmentId, thread.id)),
          workspaceTarget.disposition,
        );
      },
    });
  }, [
    activeThreadId,
    openThreadSurface,
    projectTitleById,
    settings.sidebarThreadSortOrder,
    threads,
    workspaceTarget,
  ]);

  useEffect(() => {
    if (!workspaceTarget) {
      return;
    }
    setViewStack([]);
    setQuery("");
  }, [workspaceTarget]);

  function pushView(item: CommandPaletteSubmenuItem): void {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: item.addonIcon,
        groups: item.groups,
        ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
      },
    ]);
    setQuery(item.initialQuery ?? "");
  }

  function popView(): void {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setQuery("");
  }

  function leaveSubmenu(): void {
    if (currentView) {
      popView();
      return;
    }
    clearWorkspaceTarget();
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (projects.length > 0) {
    const activeProjectTitle = currentProjectId
      ? (projectTitleById.get(currentProjectId) ?? null)
      : null;

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
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.new",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread,
            defaultProjectRef,
            defaultThreadEnvMode: settings.defaultThreadEnvMode,
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
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  if (canOpenTerminalSurface) {
    actionItems.push({
      kind: "action",
      value: "action:workspace-terminal-split-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.terminal.splitRight"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.terminal.splitRight"].title,
      icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.terminal.splitRight",
      run: async () => {
        await executeWorkspaceCommand("workspace.terminal.splitRight");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-terminal-split-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.terminal.splitDown"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.terminal.splitDown"].title,
      icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.terminal.splitDown",
      run: async () => {
        await executeWorkspaceCommand("workspace.terminal.splitDown");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-terminal-tab",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.terminal.newTab"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.terminal.newTab"].title,
      icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.terminal.newTab",
      run: async () => {
        await executeWorkspaceCommand("workspace.terminal.newTab");
      },
    });
  }

  if (canSplitFocusedPane) {
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-split-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.splitRight"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.splitRight"].title,
      icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.splitRight",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.splitRight");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-split-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.splitDown"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.splitDown"].title,
      icon: <Rows2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.splitDown",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.splitDown");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-close",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.close"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.close"].title,
      icon: <XIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.close",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.close");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-toggle-zoom",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.toggleZoom"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.toggleZoom"].title,
      icon: <Columns2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.toggleZoom",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.toggleZoom");
      },
    });
  }

  if (canUseSpatialWorkspaceCommands) {
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-previous",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.previous"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.previous"].title,
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.previous",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.previous");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-next",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.next"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.next"].title,
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.next",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.next");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-left",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.left"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.left"].title,
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.left",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.left");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.right"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.right"].title,
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.right",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.right");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-up",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.up"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.up"].title,
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.up",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.up");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-focus-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.focus.down"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.focus.down"].title,
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.focus.down",
      run: async () => {
        await executeWorkspaceCommand("workspace.focus.down");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-resize-left",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeLeft"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeLeft"].title,
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.resizeLeft",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.resizeLeft");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-resize-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeRight"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeRight"].title,
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.resizeRight",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.resizeRight");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-resize-up",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeUp"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeUp"].title,
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.resizeUp",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.resizeUp");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-resize-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeDown"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.resizeDown"].title,
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.resizeDown",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.resizeDown");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-equalize",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.equalize"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.equalize"].title,
      icon: <Rows2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.equalize",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.equalize");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-move-left",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.moveLeft"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.moveLeft"].title,
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.moveLeft",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.moveLeft");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-move-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.moveRight"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.moveRight"].title,
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.moveRight",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.moveRight");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-move-up",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.moveUp"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.moveUp"].title,
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.moveUp",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.moveUp");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-pane-move-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.pane.moveDown"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.pane.moveDown"].title,
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.pane.moveDown",
      run: async () => {
        await executeWorkspaceCommand("workspace.pane.moveDown");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-tab-move-left",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.tab.moveLeft"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.tab.moveLeft"].title,
      icon: <ArrowLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.tab.moveLeft",
      run: async () => {
        await executeWorkspaceCommand("workspace.tab.moveLeft");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-tab-move-right",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.tab.moveRight"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.tab.moveRight"].title,
      icon: <ArrowRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.tab.moveRight",
      run: async () => {
        await executeWorkspaceCommand("workspace.tab.moveRight");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-tab-move-up",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.tab.moveUp"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.tab.moveUp"].title,
      icon: <ArrowUpIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.tab.moveUp",
      run: async () => {
        await executeWorkspaceCommand("workspace.tab.moveUp");
      },
    });
    actionItems.push({
      kind: "action",
      value: "action:workspace-tab-move-down",
      searchTerms: WORKSPACE_COMMAND_METADATA["workspace.tab.moveDown"].searchTerms,
      title: WORKSPACE_COMMAND_METADATA["workspace.tab.moveDown"].title,
      icon: <ArrowDownIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "workspace.tab.moveDown",
      run: async () => {
        await executeWorkspaceCommand("workspace.tab.moveDown");
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

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const workspaceTargetGroups = useMemo(() => {
    if (!workspaceTarget) {
      return [];
    }

    const items: CommandPaletteActionItem[] = [];
    if (canOpenTerminalSurface) {
      const targetCommand =
        workspaceTarget.disposition === "split-right"
          ? "workspace.terminal.splitRight"
          : "workspace.terminal.splitDown";
      items.push({
        kind: "action",
        value: `action:workspace-target:${targetCommand}`,
        searchTerms: WORKSPACE_COMMAND_METADATA[targetCommand].searchTerms,
        title: WORKSPACE_COMMAND_METADATA[targetCommand].title,
        icon: <TerminalSquareIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: targetCommand,
        run: async () => {
          await executeWorkspaceCommand(targetCommand);
        },
      });
    }

    return [
      ...(items.length > 0 ? [{ value: "actions", label: "Actions", items }] : []),
      ...(workspaceTargetThreadItems.length > 0
        ? [{ value: "threads", label: "Threads", items: workspaceTargetThreadItems }]
        : []),
    ];
  }, [
    canOpenTerminalSurface,
    executeWorkspaceCommand,
    workspaceTarget,
    workspaceTargetThreadItems,
  ]);
  const activeGroups = currentView
    ? currentView.groups
    : workspaceTarget
      ? workspaceTargetGroups
      : rootGroups;

  const displayedGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null || workspaceTarget !== null,
    projectSearchItems: projectSearchItems,
    threadSearchItems: allThreadItems,
  });

  const isSubmenu = paletteMode === "submenu" || workspaceTarget !== null;
  const inputPlaceholder = workspaceTarget
    ? "Open in split..."
    : getCommandPaletteInputPlaceholder(paletteMode);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      leaveSubmenu();
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to run command",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    });
  }

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
    >
      <Command
        key={`${viewStack.length}-${workspaceTarget?.disposition ?? "root"}`}
        aria-label="Command palette"
        autoHighlight="always"
        mode="none"
        onValueChange={handleQueryChange}
        value={query}
      >
        <CommandInput
          placeholder={inputPlaceholder}
          wrapperClassName={
            isSubmenu
              ? "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto [&_[data-slot=autocomplete-start-addon]]:cursor-pointer"
              : undefined
          }
          {...(isSubmenu
            ? {
                startAddon: (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center"
                    aria-label="Back"
                    onClick={leaveSubmenu}
                  >
                    <ArrowLeftIcon />
                  </button>
                ),
              }
            : {})}
          onKeyDown={handleKeyDown}
        />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandPaletteResults
            groups={displayedGroups}
            isActionsOnly={isActionsOnly}
            keybindings={keybindings}
            onExecuteItem={executeItem}
          />
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className={cn("text-muted-foreground/80")}>Navigate</span>
            </KbdGroup>
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Select</span>
            </KbdGroup>
            {isSubmenu ? (
              <KbdGroup className="items-center gap-1.5">
                <Kbd>Backspace</Kbd>
                <span className={cn("text-muted-foreground/80")}>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <span className={cn("text-muted-foreground/80")}>Close</span>
            </KbdGroup>
          </div>
        </CommandFooter>
      </Command>
    </CommandDialogPopup>
  );
}
