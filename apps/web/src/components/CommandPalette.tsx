import {
  BotIcon,
  FolderIcon,
  GitBranchIcon,
  PanelBottomIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquareSplitHorizontalIcon,
  TerminalSquareIcon,
  MessageSquareIcon,
  StopCircleIcon,
  GhostIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ProviderInteractionMode,
  type ResolvedKeybindingsConfig,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProjectThreadNavigation } from "../hooks/useProjectThreadNavigation";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { useStore } from "../store";
import { type Project, type ProjectScript, type Thread } from "../types";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "./ui/command";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";

type PaletteGroupId = "actions" | "scripts" | "projects" | "threads";

interface PaletteItem {
  id: string;
  group: PaletteGroupId;
  title: string;
  subtitle?: string;
  keywords?: string[];
  shortcut?: string | null;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

interface CommandPaletteProps {
  threadId: ThreadId;
  activeThread: Thread;
  activeProject?: Project | undefined;
  keybindings: ResolvedKeybindingsConfig;
  diffOpen: boolean;
  terminalOpen: boolean;
  isGitRepo: boolean;
  isWorking: boolean;
  canCreateTerminal: boolean;
  canSplitTerminal: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  onToggleDiff: () => void;
  onToggleTerminal: () => void;
  onCreateTerminal: () => void;
  onSplitTerminal: () => void;
  onToggleInteractionMode: () => void;
  onToggleRuntimeMode: () => void;
  onInterrupt: () => void | Promise<void>;
  onRunProjectScript?: ((script: ProjectScript) => void | Promise<void>) | undefined;
  ghosttySplitOpen?: boolean;
  onToggleGhosttySplit?: () => void;
}

const GROUP_LABELS: Record<PaletteGroupId, string> = {
  actions: "Actions",
  scripts: "Scripts",
  projects: "Projects",
  threads: "Threads",
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function threadSubtitle(thread: Thread, projectName: string | undefined): string {
  const parts: string[] = [];
  if (projectName) parts.push(projectName);
  if (thread.session?.status === "running") {
    parts.push("working");
  } else if (thread.session?.status === "connecting") {
    parts.push("connecting");
  }
  parts.push(formatRelativeTime(thread.createdAt));
  return parts.join(" · ");
}

function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
}

function matchesPaletteQuery(item: PaletteItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return true;

  const haystack = [
    item.title,
    item.subtitle ?? "",
    ...(item.keywords ?? []),
  ]
    .join(" ")
    .toLocaleLowerCase();

  return normalizedQuery
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => haystack.includes(token));
}

function groupPaletteItems(items: ReadonlyArray<PaletteItem>) {
  return Object.entries(GROUP_LABELS)
    .map(([group, label]) => ({
      group: group as PaletteGroupId,
      label,
      items: items.filter((item) => item.group === group),
    }))
    .filter((entry) => entry.items.length > 0);
}

export default function CommandPalette({
  threadId,
  activeThread,
  activeProject,
  keybindings,
  diffOpen,
  terminalOpen,
  isGitRepo,
  isWorking,
  canCreateTerminal,
  canSplitTerminal,
  interactionMode,
  runtimeMode,
  onToggleDiff,
  onToggleTerminal,
  onCreateTerminal,
  onSplitTerminal,
  onToggleInteractionMode,
  onToggleRuntimeMode,
  onInterrupt,
  onRunProjectScript,
  ghosttySplitOpen,
  onToggleGhosttySplit,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const { openOrCreateThread, openProject } = useProjectThreadNavigation(threadId);
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );

  const paletteShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "commandPalette.toggle"),
    [keybindings],
  );
  const newThreadShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );
  const newLocalThreadShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.newLocal"),
    [keybindings],
  );
  const diffShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const terminalNewShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const terminalSplitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );

  const actionItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "action:settings",
        group: "actions",
        title: "Open settings",
        subtitle: "Configure appearance, models, keybindings, and safety",
        keywords: ["preferences", "config"],
        icon: <SettingsIcon className="size-4" />,
        onSelect: () => navigate({ to: "/settings" }),
      },
    ];

    if (activeProject) {
      items.unshift(
        {
          id: `action:new-thread:${activeProject.id}`,
          group: "actions",
          title: `New thread in ${activeProject.name}`,
          subtitle: "Use the current project context",
          keywords: ["chat", "conversation", "draft"],
          shortcut: newThreadShortcutLabel,
          icon: <MessageSquareIcon className="size-4" />,
          onSelect: () =>
            openOrCreateThread(activeProject.id, {
              branch: activeThread.branch ?? null,
              worktreePath: activeThread.worktreePath ?? null,
              envMode: activeThread.worktreePath ? "worktree" : "local",
            }),
        },
        {
          id: `action:new-local-thread:${activeProject.id}`,
          group: "actions",
          title: `New local thread in ${activeProject.name}`,
          subtitle: "Start fresh without reusing the current worktree",
          keywords: ["chat", "conversation", "local", "draft"],
          shortcut: newLocalThreadShortcutLabel,
          icon: <SparklesIcon className="size-4" />,
          onSelect: () =>
            openOrCreateThread(activeProject.id, {
              branch: null,
              worktreePath: null,
              envMode: "local",
            }),
        },
      );
    }

    if (isGitRepo) {
      items.push({
        id: "action:toggle-diff",
        group: "actions",
        title: diffOpen ? "Hide diff panel" : "Show diff panel",
        subtitle: "Toggle the thread diff viewer",
        keywords: ["git", "changes", "files"],
        shortcut: diffShortcutLabel,
        icon: <GitBranchIcon className="size-4" />,
        onSelect: onToggleDiff,
      });
    }

    items.push({
      id: "action:toggle-terminal",
      group: "actions",
      title: terminalOpen ? "Hide terminal" : "Show terminal",
      subtitle: "Toggle the thread terminal drawer",
      keywords: ["shell", "console"],
      shortcut: terminalToggleShortcutLabel,
      icon: <PanelBottomIcon className="size-4" />,
      onSelect: onToggleTerminal,
    });

    items.push({
      id: "action:new-terminal",
      group: "actions",
      title: "Create terminal",
      subtitle: canCreateTerminal ? "Open a new terminal for this thread" : "Terminal limit reached",
      keywords: ["shell", "console"],
      shortcut: terminalNewShortcutLabel,
      icon: <TerminalSquareIcon className="size-4" />,
      disabled: !canCreateTerminal,
      onSelect: onCreateTerminal,
    });

    items.push({
      id: "action:split-terminal",
      group: "actions",
      title: "Split terminal",
      subtitle: canSplitTerminal ? "Split the current terminal group" : "Terminal limit reached",
      keywords: ["shell", "console", "pane"],
      shortcut: terminalSplitShortcutLabel,
      icon: <SquareSplitHorizontalIcon className="size-4" />,
      disabled: !canSplitTerminal,
      onSelect: onSplitTerminal,
    });

    if (onToggleGhosttySplit) {
      items.push({
        id: "action:toggle-ghostty-split",
        group: "actions",
        title: ghosttySplitOpen ? "Hide Ghostty split view" : "Show Ghostty split view",
        subtitle: "Toggle the libghostty-powered split terminal (WASM)",
        keywords: ["ghostty", "split", "wasm", "libghostty", "terminal"],
        icon: <GhostIcon className="size-4" />,
        onSelect: onToggleGhosttySplit,
      });
    }

    items.push({
      id: "action:toggle-interaction-mode",
      group: "actions",
      title: interactionMode === "plan" ? "Switch to chat mode" : "Switch to plan mode",
      subtitle:
        interactionMode === "plan"
          ? "Return to direct implementation and follow-up chat"
          : "Ask the agent to plan before implementing",
      keywords: ["mode", "planner"],
      icon: <BotIcon className="size-4" />,
      onSelect: onToggleInteractionMode,
    });

    items.push({
      id: "action:toggle-runtime-mode",
      group: "actions",
      title: runtimeMode === "full-access" ? "Switch to supervised mode" : "Switch to full access",
      subtitle:
        runtimeMode === "full-access"
          ? "Require approvals before sensitive actions"
          : "Allow the agent to execute without approval prompts",
      keywords: ["mode", "permissions", "approval", "access"],
      icon: <SparklesIcon className="size-4" />,
      onSelect: onToggleRuntimeMode,
    });

    if (isWorking) {
      items.push({
        id: "action:interrupt",
        group: "actions",
        title: "Stop active turn",
        subtitle: "Interrupt the current agent turn",
        keywords: ["cancel", "interrupt", "stop"],
        icon: <StopCircleIcon className="size-4" />,
        onSelect: onInterrupt,
      });
    }

    return items;
  }, [
    activeProject,
    activeThread.branch,
    activeThread.worktreePath,
    canCreateTerminal,
    canSplitTerminal,
    diffOpen,
    diffShortcutLabel,
    interactionMode,
    isGitRepo,
    isWorking,
    newLocalThreadShortcutLabel,
    newThreadShortcutLabel,
    onCreateTerminal,
    onInterrupt,
    onSplitTerminal,
    onToggleDiff,
    onToggleInteractionMode,
    onToggleRuntimeMode,
    onToggleTerminal,
    onToggleGhosttySplit,
    ghosttySplitOpen,
    openOrCreateThread,
    navigate,
    runtimeMode,
    terminalNewShortcutLabel,
    terminalOpen,
    terminalSplitShortcutLabel,
    terminalToggleShortcutLabel,
  ]);

  const scriptItems = useMemo<PaletteItem[]>(() => {
    if (!activeProject || !onRunProjectScript) return [];
    return activeProject.scripts.map((script) => ({
      id: `script:${script.id}`,
      group: "scripts",
      title: script.name,
      subtitle: script.command,
      keywords: [script.command, activeProject.name, "script", "action"],
      icon: <PlayIcon className="size-4" />,
      onSelect: () => onRunProjectScript(script),
    }));
  }, [activeProject, onRunProjectScript]);

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      projects
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((project) => {
          const latestThread = threads
            .filter((thread) => thread.projectId === project.id)
            .toSorted((left, right) => {
              const byDate = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
              if (byDate !== 0) return byDate;
              return right.id.localeCompare(left.id);
            })[0];
          const hasDraft = Object.values(draftThreadsByThreadId).some(
            (draftThread) => draftThread.projectId === project.id,
          );
          const projectSubtitle = latestThread
            ? `Latest thread: ${latestThread.title}`
            : hasDraft
              ? "Draft thread available"
              : "No threads yet";
          return {
            id: `project:${project.id}`,
            group: "projects",
            title: project.name,
            subtitle: projectSubtitle,
            keywords: [project.cwd, project.name, latestThread?.title ?? ""],
            icon: <FolderIcon className="size-4" />,
            onSelect: () => openProject(project.id),
          } satisfies PaletteItem;
        }),
    [draftThreadsByThreadId, openProject, projects, threads],
  );

  const threadItems = useMemo<PaletteItem[]>(
    () =>
      threads
        .toSorted((left, right) => {
          const byDate = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return right.id.localeCompare(left.id);
        })
        .map((thread) => ({
          id: `thread:${thread.id}`,
          group: "threads",
          title: thread.title,
          subtitle: threadSubtitle(thread, projectNameById.get(thread.projectId)),
          keywords: [thread.model, projectNameById.get(thread.projectId) ?? "", thread.id],
          icon: <MessageSquareIcon className="size-4" />,
          onSelect: () =>
            navigate({
              to: "/$threadId",
              params: { threadId: thread.id },
            }),
        })),
    [navigate, projectNameById, threads],
  );

  const filteredItems = useMemo(
    () => [...actionItems, ...scriptItems, ...projectItems, ...threadItems].filter((item) => matchesPaletteQuery(item, query)),
    [actionItems, projectItems, query, scriptItems, threadItems],
  );
  const groupedItems = useMemo(() => groupPaletteItems(filteredItems), [filteredItems]);

  /** Pre-compute flat visible index for each item id so we avoid mutating a counter during render. */
  const flatVisibleIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const group of groupedItems) {
      for (const item of group.items) {
        map.set(item.id, index);
        index += 1;
      }
    }
    return map;
  }, [groupedItems]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlightedIndex(0);
      itemRefs.current = [];
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  useEffect(() => {
    setHighlightedIndex((current) => {
      if (filteredItems.length === 0) return 0;
      return Math.min(current, filteredItems.length - 1);
    });
  }, [filteredItems]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open]);

  useEffect(() => {
    setOpen(false);
  }, [threadId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [keybindings, terminalOpen]);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  const activateItem = useCallback(async (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    closePalette();
    try {
      await item.onSelect();
    } catch (error) {
      console.error("Failed to execute command palette action", error);
    }
  }, [closePalette]);

  const onListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (filteredItems.length === 0) return;
        setHighlightedIndex((current) => (current + 1) % filteredItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredItems.length === 0) return;
        setHighlightedIndex((current) => (current - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void activateItem(filteredItems[highlightedIndex]);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePalette();
    },
    [activateItem, closePalette, filteredItems, highlightedIndex],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Command palette"
        className="max-w-2xl overflow-hidden p-0"
        onKeyDown={onListKeyDown}
      >
        <div className="border-b border-border/80 px-4 py-3">
          <label className="flex items-center gap-3 text-sm text-muted-foreground">
            <SearchIcon className="size-4 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlightedIndex(0);
              }}
              placeholder="Search actions, threads, projects, and scripts"
              className="w-full border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </label>
        </div>

        <div className="max-h-[min(70vh,34rem)] min-h-0">
          <ScrollArea scrollFade>
            <div className="space-y-3 p-3">
              {groupedItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                  No matching commands found.
                </div>
              ) : (
                groupedItems.map((group) => (
                  <section key={group.group} className="space-y-1.5">
                    <div className="px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/75">
                      {group.label}
                    </div>
                    <div className="space-y-1">
                      {group.items.map((item) => {
                        const itemIndex = flatVisibleIndexById.get(item.id) ?? 0;
                        const isHighlighted = highlightedIndex === itemIndex;
                        const isActiveThread = item.id === `thread:${activeThread.id}`;
                        return (
                          <button
                            key={item.id}
                            ref={(element) => {
                              itemRefs.current[itemIndex] = element;
                            }}
                            type="button"
                            disabled={item.disabled}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                              item.disabled
                                ? "cursor-not-allowed border-border/60 bg-muted/10 text-muted-foreground/55"
                                : isHighlighted
                                  ? "border-primary/40 bg-accent text-accent-foreground"
                                  : "border-border/70 bg-background hover:bg-muted/35",
                            )}
                            onMouseEnter={() => setHighlightedIndex(itemIndex)}
                            onClick={() => {
                              void activateItem(item);
                            }}
                          >
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20">
                              {item.icon}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                                <span className="truncate">{item.title}</span>
                                {isActiveThread ? (
                                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                                    Current
                                  </span>
                                ) : null}
                              </span>
                              {item.subtitle ? (
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                  {item.subtitle}
                                </span>
                              ) : null}
                            </span>
                            {item.shortcut ? (
                              <kbd className="shrink-0 text-[11px] tracking-widest text-muted-foreground/80">
                                {item.shortcut}
                              </kbd>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <CommandFooter>
          <span>Enter to open</span>
          <span>Up/Down to navigate</span>
          <span>{paletteShortcutLabel ? `${paletteShortcutLabel} or Esc to close` : "Esc to close"}</span>
        </CommandFooter>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
