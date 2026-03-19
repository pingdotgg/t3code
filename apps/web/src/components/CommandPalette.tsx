"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerLeftUpIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAppSettings } from "../appSettings";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  getBrowseParentPath,
  isFilesystemBrowseQuery,
} from "../lib/projectPaths";
import { addProjectFromPath } from "../lib/projectAdd";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import {
  ADDON_ICON_CLASS,
  buildBrowseGroups,
  buildProjectActionItems,
  buildThreadActionItems,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteInputStartAddon,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { Button } from "./ui/button";
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

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {children}
      <CommandPaletteDialog />
    </CommandDialog>
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
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = query.startsWith(">");
  const isBrowsing = isFilesystemBrowseQuery(query);
  const [debouncedBrowsePath] = useDebouncedValue(query, { wait: 200 });
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const { settings } = useAppSettings();
  const { activeDraftThread, activeThread, handleNewThread, projects } = useHandleNewThread();
  const threads = useStore((store) => store.threads);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const [browseGeneration, setBrowseGeneration] = useState(0);

  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );

  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;

  const { data: browseEntries = [] } = useQuery({
    queryKey: ["filesystemBrowse", debouncedBrowsePath, currentProjectCwd],
    queryFn: async () => {
      const api = readNativeApi();
      if (!api) return [];

      const result = await api.filesystem.browse({
        partialPath: debouncedBrowsePath,
        ...(currentProjectCwd ? { cwd: currentProjectCwd } : {}),
      });
      return result.entries;
    },
    enabled:
      isBrowsing &&
      debouncedBrowsePath.length > 0 &&
      (!debouncedBrowsePath.startsWith(".") || currentProjectCwd !== null),
  });

  const projectThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-thread-in",
        icon: <FolderIcon className={ITEM_ICON_CLASS} />,
        runProject: async (projectId) => {
          await handleNewThread(projectId, {
            envMode: settings.defaultThreadEnvMode,
          });
        },
      }),
    [handleNewThread, projects, settings.defaultThreadEnvMode],
  );

  const projectLocalThreadItems = useMemo(
    () =>
      buildProjectActionItems({
        projects,
        valuePrefix: "new-local-thread-in",
        icon: <FolderIcon className={ITEM_ICON_CLASS} />,
        runProject: async (projectId) => {
          await handleNewThread(projectId, {
            envMode: "local",
          });
        },
      }),
    [handleNewThread, projects],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThread?.id ? { activeThreadId: activeThread.id } : {}),
        projectTitleById,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        runThread: async (threadId) => {
          await navigate({
            to: "/$threadId",
            params: { threadId },
          });
        },
      }),
    [activeThread?.id, navigate, projectTitleById, threads],
  );

  const recentThreadItems = useMemo(
    () => allThreadItems.slice(0, RECENT_THREAD_LIMIT),
    [allThreadItems],
  );

  const pushView = useCallback((item: CommandPaletteSubmenuItem) => {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: item.addonIcon,
        groups: item.groups,
        ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
      },
    ]);
    setHighlightedItemValue(null);
    setQuery(item.initialQuery ?? "");
  }, []);

  const popView = useCallback(() => {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }, []);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setHighlightedItemValue(null);
      setQuery(nextQuery);
      if (nextQuery === "" && currentView?.initialQuery) {
        popView();
      }
    },
    [currentView, popView],
  );

  const rootGroups = useMemo<CommandPaletteGroup[]>(() => {
    const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

    if (projects.length > 0) {
      const activeProjectTitle = currentProjectId
        ? (projectTitleById.get(currentProjectId) ?? null)
        : null;

      if (activeProjectTitle) {
        actionItems.push({
          kind: "action",
          value: "action:new-thread",
          label: `new thread chat create ${activeProjectTitle}`.trim(),
          title: (
            <>
              New thread in <span className="font-semibold">{activeProjectTitle}</span>
            </>
          ),
          searchText: "new thread chat create draft",
          icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "chat.new",
          run: async () => {
            await startNewThreadFromContext({
              activeDraftThread,
              activeThread,
              defaultThreadEnvMode: settings.defaultThreadEnvMode,
              handleNewThread,
              projects,
            });
          },
        });

        actionItems.push({
          kind: "action",
          value: "action:new-local-thread",
          label: `new fresh thread chat create ${activeProjectTitle}`.trim(),
          title: (
            <>
              New fresh thread in <span className="font-semibold">{activeProjectTitle}</span>
            </>
          ),
          searchText: "new local thread chat create fresh default environment",
          icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "chat.newLocal",
          run: async () => {
            await startNewLocalThreadFromContext({
              activeDraftThread,
              activeThread,
              defaultThreadEnvMode: settings.defaultThreadEnvMode,
              handleNewThread,
              projects,
            });
          },
        });
      }

      actionItems.push({
        kind: "submenu",
        value: "action:new-thread-in",
        label: "new thread in project",
        title: "New thread in...",
        searchText: "new thread project pick choose select",
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
      });

      actionItems.push({
        kind: "submenu",
        value: "action:new-local-thread-in",
        label: "new local thread in project",
        title: "New local thread in...",
        searchText: "new local thread project pick choose select fresh default environment",
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "projects", label: "Projects", items: projectLocalThreadItems }],
      });
    }

    actionItems.push({
      kind: "submenu",
      value: "action:add-project",
      label: "add project folder directory browse",
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [],
      initialQuery: "~/",
    });

    actionItems.push({
      kind: "action",
      value: "action:settings",
      label: "settings preferences configuration keybindings",
      title: "Open settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings" });
      },
    });

    const groups: CommandPaletteGroup[] = [];
    if (actionItems.length > 0) {
      groups.push({
        value: "actions",
        label: "Actions",
        items: actionItems,
      });
    }
    if (recentThreadItems.length > 0) {
      groups.push({
        value: "recent-threads",
        label: "Recent Threads",
        items: recentThreadItems,
      });
    }
    return groups;
  }, [
    activeDraftThread,
    activeThread,
    currentProjectId,
    handleNewThread,
    navigate,
    projectLocalThreadItems,
    projectThreadItems,
    projectTitleById,
    projects,
    recentThreadItems,
    settings.defaultThreadEnvMode,
  ]);

  const activeGroups = currentView ? currentView.groups : rootGroups;

  const filteredGroups = useMemo(
    () =>
      filterCommandPaletteGroups({
        activeGroups,
        query: deferredQuery,
        isInSubmenu: currentView !== null,
        projectSearchItems: projectThreadItems,
        threadSearchItems: allThreadItems,
      }),
    [activeGroups, allThreadItems, currentView, deferredQuery, projectThreadItems],
  );

  const handleAddProject = useCallback(
    async (rawCwd: string) => {
      const api = readNativeApi();
      if (!api) return;

      try {
        await addProjectFromPath(
          {
            api,
            currentProjectCwd,
            defaultThreadEnvMode: settings.defaultThreadEnvMode,
            handleNewThread,
            navigateToThread: async (threadId) => {
              await navigate({
                to: "/$threadId",
                params: { threadId },
              });
            },
            projects,
            threads,
          },
          rawCwd,
        );
        setOpen(false);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to add project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [
      currentProjectCwd,
      handleNewThread,
      navigate,
      projects,
      setOpen,
      settings.defaultThreadEnvMode,
      threads,
    ],
  );

  const browseTo = useCallback(
    (name: string) => {
      setHighlightedItemValue(null);
      setQuery(appendBrowsePathSegment(query, name));
      setBrowseGeneration((generation) => generation + 1);
    },
    [query],
  );

  const browseUp = useCallback(() => {
    const parentPath = getBrowseParentPath(query);
    if (parentPath === null) {
      return;
    }

    setHighlightedItemValue(null);
    setQuery(parentPath);
    setBrowseGeneration((generation) => generation + 1);
  }, [query]);

  const canBrowseUp = isBrowsing && getBrowseParentPath(query) !== null;

  const browseGroups = useMemo(
    () =>
      buildBrowseGroups({
        browseEntries,
        canBrowseUp,
        upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
        directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
        browseUp,
        browseTo,
      }),
    [browseEntries, browseTo, browseUp, canBrowseUp],
  );

  const displayedGroups = isBrowsing ? browseGroups : filteredGroups;
  const inputPlaceholder = getCommandPaletteInputPlaceholder(paletteMode);
  const inputStartAddon = getCommandPaletteInputStartAddon({
    mode: paletteMode,
    currentViewAddonIcon: currentView?.addonIcon ?? null,
    browseIcon: <FolderPlusIcon />,
  });
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (isBrowsing && event.key === "Enter" && highlightedItemValue === null) {
        event.preventDefault();
        void handleAddProject(query.trim());
      }

      if (event.key === "Backspace" && query === "" && isSubmenu) {
        event.preventDefault();
        popView();
      }
    },
    [handleAddProject, highlightedItemValue, isBrowsing, isSubmenu, popView, query],
  );

  const executeItem = useCallback(
    (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
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
    },
    [pushView, setOpen],
  );

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-testid="command-palette"
    >
      <Command
        key={`${viewStack.length}-${browseGeneration}`}
        aria-label="Command palette"
        autoHighlight={isBrowsing ? false : "always"}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={handleQueryChange}
        value={query}
      >
        <div className="relative">
          <CommandInput
            className={isBrowsing ? "pe-16" : undefined}
            placeholder={inputPlaceholder}
            startAddon={inputStartAddon}
            onKeyDown={handleKeyDown}
          />
          {isBrowsing ? (
            <Button
              variant="outline"
              size="xs"
              className="absolute end-2.5 top-1/2 -translate-y-1/2"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void handleAddProject(query.trim());
              }}
            >
              Add
            </Button>
          ) : null}
        </div>
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
