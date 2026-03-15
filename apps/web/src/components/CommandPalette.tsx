"use client";

import { type KeybindingCommand } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, MessageSquareIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAppSettings } from "../appSettings";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { shortcutLabelForCommand } from "../keybindings";
import { formatRelativeTime } from "../relativeTime";
import { useStore } from "../store";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "./ui/command";
import { toastManager } from "./ui/toast";

const RECENT_THREAD_LIMIT = 12;

interface CommandPaletteState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly toggleOpen: () => void;
}

interface CommandPaletteItem {
  readonly value: string;
  readonly label: string;
  readonly title: string;
  readonly description?: string;
  readonly searchText?: string;
  readonly timestamp?: string;
  readonly icon: ReactNode;
  readonly shortcutCommand?: KeybindingCommand;
  readonly run: () => Promise<void>;
}

interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteItem>;
}

const CommandPaletteContext = createContext<CommandPaletteState | null>(null);

function iconClassName() {
  return "size-4 text-muted-foreground/80";
}

function compareThreadsByCreatedAtDesc(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string },
): number {
  const byTimestamp = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (!Number.isNaN(byTimestamp) && byTimestamp !== 0) {
    return byTimestamp;
  }
  return right.id.localeCompare(left.id);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider.");
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const value = useMemo<CommandPaletteState>(
    () => ({
      open,
      setOpen,
      toggleOpen,
    }),
    [open, toggleOpen],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {children}
        <CommandPaletteDialog />
      </CommandDialog>
    </CommandPaletteContext.Provider>
  );
}

function CommandPaletteDialog() {
  const { open } = useCommandPalette();
  if (!open) {
    return null;
  }

  return <OpenCommandPaletteDialog />;
}

function OpenCommandPaletteDialog() {
  const navigate = useNavigate();
  const { setOpen } = useCommandPalette();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const { settings } = useAppSettings();
  const { activeDraftThread, activeThread, handleNewThread, projects } = useHandleNewThread();
  const threads = useStore((store) => store.threads);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );

  const allGroups = useMemo<CommandPaletteGroup[]>(() => {
    const actionItems: CommandPaletteItem[] = [];
    if (projects.length > 0) {
      const activeProjectTitle =
        projectTitleById.get(
          activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]!.id,
        ) ?? null;

      actionItems.push({
        value: "action:new-thread",
        label: `new thread chat create ${activeProjectTitle ?? ""}`.trim(),
        title: "New thread",
        description: activeProjectTitle
          ? `Create a draft thread in ${activeProjectTitle}`
          : "Create a new draft thread",
        searchText: "new thread chat create draft",
        icon: <SquarePenIcon className={iconClassName()} />,
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
        value: "action:new-local-thread",
        label: `new local thread chat create ${activeProjectTitle ?? ""}`.trim(),
        title: "New local thread",
        description: activeProjectTitle
          ? `Create a fresh ${settings.defaultThreadEnvMode} thread in ${activeProjectTitle}`
          : "Create a fresh thread using the default environment",
        searchText: "new local thread chat create fresh default environment",
        icon: <SquarePenIcon className={iconClassName()} />,
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
      value: "action:settings",
      label: "settings preferences configuration keybindings",
      title: "Open settings",
      description: "Open app settings and keybinding configuration",
      icon: <SettingsIcon className={iconClassName()} />,
      run: async () => {
        await navigate({ to: "/settings" });
      },
    });

    const projectItems = projects.map<CommandPaletteItem>((project) => ({
      value: `project:${project.id}`,
      label: `${project.name} ${project.cwd}`.trim(),
      title: project.name,
      description: project.cwd,
      icon: <FolderIcon className={iconClassName()} />,
      run: async () => {
        await handleNewThread(project.id, {
          envMode: settings.defaultThreadEnvMode,
        });
      },
    }));

    const recentThreadItems = threads
      .toSorted(compareThreadsByCreatedAtDesc)
      .slice(0, RECENT_THREAD_LIMIT)
      .map<CommandPaletteItem>((thread) => {
        const projectTitle = projectTitleById.get(thread.projectId);
        const descriptionParts = [
          projectTitle,
          thread.branch ? `#${thread.branch}` : null,
          thread.id === activeThread?.id ? "Current thread" : null,
        ].filter(Boolean);

        return {
          value: `thread:${thread.id}`,
          label: `${thread.title} ${projectTitle ?? ""} ${thread.branch ?? ""}`.trim(),
          title: thread.title,
          description: descriptionParts.join(" · "),
          timestamp: formatRelativeTime(thread.createdAt),
          icon: <MessageSquareIcon className={iconClassName()} />,
          run: async () => {
            await navigate({
              to: "/$threadId",
              params: { threadId: thread.id },
            });
          },
        };
      });

    const nextGroups: CommandPaletteGroup[] = [];
    if (actionItems.length > 0) {
      nextGroups.push({
        value: "actions",
        label: "Actions",
        items: actionItems,
      });
    }
    if (projectItems.length > 0) {
      nextGroups.push({
        value: "projects",
        label: "Projects",
        items: projectItems,
      });
    }
    if (recentThreadItems.length > 0) {
      nextGroups.push({
        value: "recent-threads",
        label: "Recent Threads",
        items: recentThreadItems,
      });
    }
    return nextGroups;
  }, [
    activeDraftThread,
    activeThread,
    handleNewThread,
    navigate,
    projectTitleById,
    projects,
    settings.defaultThreadEnvMode,
    threads,
  ]);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = normalizeSearchText(deferredQuery);
    if (normalizedQuery.length === 0) {
      return allGroups;
    }

    return allGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const haystack = normalizeSearchText(
            [
              item.title,
              item.searchText ?? item.label,
              item.searchText ? "" : (item.description ?? ""),
            ].join(" "),
          );
          return haystack.includes(normalizedQuery);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [allGroups, deferredQuery]);

  const executeItem = useCallback(
    (item: CommandPaletteItem) => {
      setOpen(false);
      void item.run().catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
    },
    [setOpen],
  );

  return (
    <CommandDialogPopup
      aria-label="Command palette"
      className="overflow-hidden p-0"
      data-testid="command-palette"
    >
      <Command aria-label="Command palette" mode="none" onValueChange={setQuery} value={query}>
        <CommandInput placeholder="Search commands, projects, and threads..." />
        <CommandPanel className="max-h-[min(28rem,70vh)]">
          <CommandList>
            {filteredGroups.map((group) => (
              <CommandGroup items={group.items} key={group.value}>
                <CommandGroupLabel>{group.label}</CommandGroupLabel>
                <CommandCollection>
                  {(item) => {
                    const shortcutLabel = item.shortcutCommand
                      ? shortcutLabelForCommand(keybindings, item.shortcutCommand)
                      : null;
                    return (
                      <CommandItem
                        value={item.value}
                        className="cursor-pointer gap-3"
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          executeItem(item);
                        }}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30">
                          {item.icon}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm text-foreground">{item.title}</span>
                          {item.description ? (
                            <span className="truncate text-muted-foreground/70 text-xs">
                              {item.description}
                            </span>
                          ) : null}
                        </span>
                        {item.timestamp ? (
                          <span className="min-w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
                            {item.timestamp}
                          </span>
                        ) : null}
                        {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
                      </CommandItem>
                    );
                  }}
                </CommandCollection>
              </CommandGroup>
            ))}
          </CommandList>
          <CommandEmpty className="py-10 text-sm">
            No matching commands, projects, or threads.
          </CommandEmpty>
        </CommandPanel>
        <CommandFooter className="gap-3 max-sm:flex-col max-sm:items-start">
          <span>
            Search actions, start a thread in any project, or jump back into recent threads.
          </span>
          <div className="flex items-center gap-3">
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Enter</Kbd>
              <span className={cn("text-muted-foreground/80")}>Open</span>
            </KbdGroup>
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
