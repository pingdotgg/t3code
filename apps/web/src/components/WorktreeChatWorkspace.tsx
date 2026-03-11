import {
  type EditorId,
  type KeybindingCommand,
  type ProjectId,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type WorktreeId,
} from "@repo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type DockviewReadyEvent,
  themeDark,
  themeLight,
  type IDockviewPanelProps,
} from "dockview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, Clock3Icon, PlusIcon, XIcon } from "lucide-react";

import ChatView from "./ChatView";
import GitActionsControl from "./GitActionsControl";
import OpenInPicker from "./OpenInPicker";
import ProjectScriptsControl, { type NewProjectScriptInput } from "./ProjectScriptsControl";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIcons";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { KbdTooltip } from "./ui/kbd-tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { SidebarTrigger } from "./ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { gitBranchesQueryOptions } from "../lib/gitReactQuery";
import { formatRelativeTime } from "../lib/relativeTime";
import { decodeProjectScriptKeybindingRule } from "../lib/projectScriptKeybindings";
import { ensureWorktreeDraftThread } from "../lib/worktreeDraftThread";
import { worktreeDisplaySubtitle, worktreeDisplayTitle } from "../lib/worktrees";
import { cn, newCommandId, randomUUID } from "../lib/utils";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { getNewThreadShortcutHint } from "../newThreadShortcut";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
  projectScriptRuntimeEnv,
} from "../projectScripts";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ProjectScript,
} from "../types";
import type { Worktree } from "../types";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import {
  type WorktreeDockPanelParams,
  sanitizeSerializedDockviewLayout,
  useWorktreeChatLayoutStore,
} from "../worktreeChatLayoutStore";

const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
const DOCKVIEW_THREAD_COMPONENT = "thread-chat";
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];

declare global {
  interface Window {
    __T3CODE_DOCKVIEW_API__?: DockviewApi;
  }
}

interface WorkspaceThreadEntry {
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  worktreeId: WorktreeId;
  worktreePath: string | null;
  branch: string | null;
  createdAt: string;
  isServerThread: boolean;
}

interface WorktreeChatWorkspaceProps {
  threadId: ThreadId;
  worktreeId: WorktreeId;
}

type DockviewHeaderActionsProps = Parameters<
  NonNullable<ComponentProps<typeof DockviewReact>["rightHeaderActionsComponent"]>
>[0];

interface DockThreadHeaderActionsExtraProps {
  worktree: Worktree | null;
  projectName: string | null;
  worktreeSubtitle: string | null;
  unopenedThreads: readonly WorkspaceThreadEntry[];
  onCreateThread: (referencePanelId: ThreadId | null) => void;
  onOpenThread: (threadId: ThreadId, referencePanelId: ThreadId | null) => void;
}

function readLastInvokedScriptByProjectFromStorage(): Record<string, string> {
  const stored = localStorage.getItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
  if (!stored) return {};

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function DockThreadPanel({
  params,
  routeThreadId,
}: IDockviewPanelProps<WorktreeDockPanelParams> & { routeThreadId: ThreadId }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ChatView
        threadId={params.threadId}
        routeActive={params.threadId === routeThreadId}
        showHeader={false}
        showTerminalDrawer={false}
        showPlanSidebar={false}
        enableGlobalShortcuts={false}
      />
    </div>
  );
}

function useDockPanelTitle(api: IDockviewPanelHeaderProps<WorktreeDockPanelParams>["api"]): string {
  const [title, setTitle] = useState(api.title ?? "");

  useEffect(() => {
    setTitle(api.title ?? "");
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    return () => {
      disposable.dispose();
    };
  }, [api]);

  return title;
}

function DockThreadTab(props: IDockviewPanelHeaderProps<WorktreeDockPanelParams>) {
  const title = useDockPanelTitle(props.api);
  const serverThread = useStore(
    useCallback(
      (store) => store.threads.find((thread) => thread.id === props.params.threadId) ?? null,
      [props.params.threadId],
    ),
  );
  const draftProvider = useComposerDraftStore(
    useCallback(
      (store) => store.draftsByThreadId[props.params.threadId]?.provider ?? null,
      [props.params.threadId],
    ),
  );

  const provider: ProviderKind = serverThread?.session?.provider ?? draftProvider ?? "codex";
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];

  return (
    <div className="dv-default-tab">
      <div className="dv-default-tab-content">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderIcon aria-hidden="true" className="size-3 shrink-0 opacity-75" />
          <span className="truncate">{title}</span>
        </span>
      </div>
      {props.tabLocation === "header" ? (
        <button
          aria-label={`Close ${title || "thread"}`}
          className="dv-default-tab-action appearance-none border-0 bg-transparent text-inherit"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.api.close();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

function buildThreadPanelParams(entry: WorkspaceThreadEntry): WorktreeDockPanelParams {
  return {
    threadId: entry.threadId,
    worktreeId: entry.worktreeId,
    title: entry.title,
  };
}

function DockThreadHeaderActions({
  activePanel,
  panels,
  worktree,
  projectName,
  worktreeSubtitle,
  unopenedThreads,
  onCreateThread,
  onOpenThread,
}: DockviewHeaderActionsProps & DockThreadHeaderActionsExtraProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const referencePanelId = (activePanel?.id ?? panels[0]?.id ?? null) as ThreadId | null;
  const worktreeTitle = worktree ? worktreeDisplayTitle(worktree) : "Threads";
  const newThreadShortcut = getNewThreadShortcutHint();

  return (
    <div className="dockview-thread-actions flex items-center gap-0.5 pr-1">
      <KbdTooltip label="New thread" shortcut={newThreadShortcut} side="bottom">
        <Button
          aria-label={`Create a new thread in ${worktreeTitle}`}
          className="dockview-thread-action"
          disabled={!worktree}
          size="icon-xs"
          variant="ghost"
          onClick={() => onCreateThread(referencePanelId)}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </KbdTooltip>

      <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={`Open a closed thread from ${worktreeTitle}`}
              className="dockview-thread-action"
              disabled={!worktree}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <Clock3Icon className="size-3.5" />
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[22rem] p-0" side="bottom" sideOffset={6}>
          <div className="border-b px-2.5 py-1.5">
            <div className="truncate text-xs font-medium text-foreground">{worktreeTitle}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              {worktreeSubtitle ?? projectName ?? "Worktree threads"}
            </div>
          </div>

          {unopenedThreads.length > 0 ? (
            <ul className="max-h-80 space-y-0.5 overflow-y-auto p-1.5">
              {unopenedThreads.map((entry) => (
                <li key={entry.threadId}>
                  <button
                    className="flex h-6.5 w-full items-center justify-between gap-2.5 rounded-md px-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    type="button"
                    onClick={() => {
                      onOpenThread(entry.threadId, referencePanelId);
                      setPickerOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {entry.isServerThread ? entry.title : "New thread"}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
              All threads in this worktree are already open.
            </div>
          )}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

export default function WorktreeChatWorkspace({
  threadId,
  worktreeId,
}: WorktreeChatWorkspaceProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();

  const projects = useStore((store) => store.projects);
  const worktrees = useStore((store) => store.worktrees);
  const threads = useStore((store) => store.threads);
  const setStoreThreadError = useStore((store) => store.setError);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const getDraftThreadByWorktreeId = useComposerDraftStore(
    (store) => store.getDraftThreadByWorktreeId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setWorktreeDraftThreadId = useComposerDraftStore((store) => store.setWorktreeDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const layout = useWorktreeChatLayoutStore(
    (store) => store.layoutsByWorktreeId[worktreeId] ?? null,
  );
  const setLayout = useWorktreeChatLayoutStore((store) => store.setLayout);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const restoredRef = useRef(false);
  const pendingPanelReferenceIdRef = useRef<ThreadId | null>(null);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useState<
    Record<string, string>
  >(() => readLastInvokedScriptByProjectFromStorage());

  const workspaceThreadsById = useMemo(() => {
    const next = new Map<ThreadId, WorkspaceThreadEntry>();
    for (const thread of threads) {
      if (thread.worktreeId !== worktreeId) {
        continue;
      }
      next.set(thread.id, {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        worktreeId,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        createdAt: thread.createdAt,
        isServerThread: true,
      });
    }

    for (const [draftThreadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      if (draftThread.worktreeId !== worktreeId || next.has(draftThreadId as ThreadId)) {
        continue;
      }
      next.set(draftThreadId as ThreadId, {
        threadId: draftThreadId as ThreadId,
        projectId: draftThread.projectId,
        title: "New thread",
        worktreeId,
        worktreePath: draftThread.worktreePath,
        branch: draftThread.branch,
        createdAt: draftThread.createdAt,
        isServerThread: false,
      });
    }

    return next;
  }, [draftThreadsByThreadId, threads, worktreeId]);
  const workspaceThreadIds = useMemo(
    () => new Set(workspaceThreadsById.keys()),
    [workspaceThreadsById],
  );
  const activeThread = workspaceThreadsById.get(threadId) ?? null;
  const activeWorktree = worktrees.find((worktree) => worktree.id === worktreeId) ?? null;
  const activeProject =
    projects.find(
      (project) => project.id === (activeThread?.projectId ?? activeWorktree?.projectId),
    ) ?? null;
  const activeThreadId = activeThread?.threadId ?? null;
  const gitCwd =
    activeThread?.worktreePath ??
    (activeWorktree && !activeWorktree.isRoot ? activeWorktree.workspacePath : null) ??
    activeProject?.cwd ??
    null;
  const worktreeSubtitle =
    activeWorktree && activeProject ? worktreeDisplaySubtitle(activeWorktree, activeProject) : null;

  const keybindingsQuery = useQuery(serverConfigQueryOptions());
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitCwd));
  const keybindings = keybindingsQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = keybindingsQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const isGitRepo = branchesQuery.data?.isRepo ?? true;

  const terminalState = useTerminalStateStore((state) =>
    activeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, activeThreadId)
      : selectThreadTerminalState(state.terminalStateByThreadId, "" as ThreadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);

  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProject?.cwd) return {};
    return projectScriptRuntimeEnv({
      project: { cwd: activeProject.cwd },
      worktreePath: activeThread?.worktreePath ?? null,
    });
  }, [activeProject?.cwd, activeThread?.worktreePath]);

  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const hasReachedTerminalLimit = terminalState.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT;

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    storeSplitTerminal(activeThreadId, `terminal-${randomUUID()}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedTerminalLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedTerminalLimit) return;
    storeNewTerminal(activeThreadId, `terminal-${randomUUID()}`);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedTerminalLimit, storeNewTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({ threadId: activeThreadId, terminalId, deleteHistory: true });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      nextScripts: ProjectScript[];
      keybinding: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);
      await persistProjectScripts({
        projectId: activeProject.id,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread?.isServerThread) return;

      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });

      const targetCwd = gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const shouldCreateNewTerminal =
        isBaseTerminalBusy && terminalState.terminalIds.length < MAX_THREAD_TERMINAL_COUNT;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      } else if (targetTerminalId !== terminalState.activeTerminalId) {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }

      setTerminalOpen(true);
      setTerminalFocusRequestId((value) => value + 1);

      try {
        await api.terminal.open({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          cwd: targetCwd,
          env: threadTerminalRuntimeEnv,
        });
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setStoreThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread?.isServerThread,
      activeThreadId,
      gitCwd,
      setStoreThreadError,
      setTerminalOpen,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
      threadTerminalRuntimeEnv,
    ],
  );

  useEffect(() => {
    try {
      if (Object.keys(lastInvokedScriptByProjectId).length === 0) {
        localStorage.removeItem(LAST_INVOKED_SCRIPT_BY_PROJECT_KEY);
        return;
      }
      localStorage.setItem(
        LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
        JSON.stringify(lastInvokedScriptByProjectId),
      );
    } catch {
      // Ignore storage failures.
    }
  }, [lastInvokedScriptByProjectId]);

  const addThreadPanel = useCallback(
    (api: DockviewApi, targetThreadId: ThreadId, referencePanelId?: ThreadId | null) => {
      const entry = workspaceThreadsById.get(targetThreadId);
      if (!entry) {
        return null;
      }

      const resolvedReferencePanelId =
        referencePanelId ?? pendingPanelReferenceIdRef.current ?? null;
      const referencePanel =
        (resolvedReferencePanelId ? api.getPanel(resolvedReferencePanelId) : null) ??
        api.activePanel;

      const panel = api.addPanel<WorktreeDockPanelParams>({
        id: targetThreadId,
        component: DOCKVIEW_THREAD_COMPONENT,
        title: entry.title,
        params: buildThreadPanelParams(entry),
        renderer: "always",
        ...(referencePanel
          ? {
              position: {
                referencePanel: referencePanel.id,
                direction: "within",
              } as const,
            }
          : {}),
      });
      pendingPanelReferenceIdRef.current = null;
      return panel;
    },
    [workspaceThreadsById],
  );

  const openThreadInGroup = useCallback(
    (targetThreadId: ThreadId, referencePanelId: ThreadId | null) => {
      if (!dockviewApi) return;
      const existingPanel = dockviewApi.getPanel(targetThreadId);
      if (existingPanel) {
        pendingPanelReferenceIdRef.current = null;
        existingPanel.api.setActive();
        return;
      }

      const addedPanel = addThreadPanel(dockviewApi, targetThreadId, referencePanelId);
      if (addedPanel) {
        addedPanel.api.setActive();
      }
    },
    [addThreadPanel, dockviewApi],
  );

  const handleCreateThread = useCallback(
    (referencePanelId: ThreadId | null) => {
      if (!activeProject || !activeWorktree) {
        return;
      }

      const nextThreadId = ensureWorktreeDraftThread({
        projectId: activeProject.id,
        worktreeId,
        routeThreadId: threadId,
        branch: activeWorktree.branch,
        worktreePath: activeWorktree.isRoot ? null : activeWorktree.workspacePath,
        envMode: activeWorktree.isRoot ? "local" : "worktree",
        getDraftThreadByWorktreeId,
        getDraftThread,
        setWorktreeDraftThreadId,
        setDraftThreadContext,
      });

      const existingPanel = dockviewApi?.getPanel(nextThreadId);
      if (existingPanel) {
        pendingPanelReferenceIdRef.current = null;
        existingPanel.api.setActive();
      } else if (workspaceThreadsById.has(nextThreadId)) {
        openThreadInGroup(nextThreadId, referencePanelId);
      } else {
        pendingPanelReferenceIdRef.current = referencePanelId;
      }

      if (threadId !== nextThreadId) {
        void navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      }
    },
    [
      activeProject,
      activeWorktree,
      dockviewApi,
      getDraftThread,
      getDraftThreadByWorktreeId,
      navigate,
      openThreadInGroup,
      setDraftThreadContext,
      setWorktreeDraftThreadId,
      threadId,
      workspaceThreadsById,
      worktreeId,
    ],
  );

  const unopenedThreads = useMemo(() => {
    const openThreadIds = new Set((dockviewApi?.panels ?? []).map((panel) => panel.id as ThreadId));
    return [...workspaceThreadsById.values()]
      .filter((entry) => !openThreadIds.has(entry.threadId))
      .toSorted(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.threadId.localeCompare(left.threadId),
      );
  }, [dockviewApi?.panels, workspaceThreadsById]);

  const rightHeaderActionsComponent = useCallback(
    (props: DockviewHeaderActionsProps) => (
      <DockThreadHeaderActions
        {...props}
        projectName={activeProject?.name ?? null}
        worktree={activeWorktree}
        worktreeSubtitle={worktreeSubtitle}
        unopenedThreads={unopenedThreads}
        onCreateThread={handleCreateThread}
        onOpenThread={openThreadInGroup}
      />
    ),
    [
      activeProject?.name,
      activeWorktree,
      handleCreateThread,
      openThreadInGroup,
      unopenedThreads,
      worktreeSubtitle,
    ],
  );

  const dockComponents = useMemo(
    () => ({
      [DOCKVIEW_THREAD_COMPONENT]: (props: IDockviewPanelProps<WorktreeDockPanelParams>) => (
        <DockThreadPanel {...props} routeThreadId={threadId} />
      ),
    }),
    [threadId],
  );

  useEffect(() => {
    if (!dockviewApi || restoredRef.current) return;
    restoredRef.current = true;

    const sanitizedLayout =
      layout && workspaceThreadIds.size > 0
        ? sanitizeSerializedDockviewLayout({
            layout,
            validThreadIds: workspaceThreadIds,
            worktreeId,
          })
        : null;

    dockviewApi.clear();
    if (sanitizedLayout) {
      dockviewApi.fromJSON(sanitizedLayout);
    }
    if (!dockviewApi.getPanel(threadId)) {
      addThreadPanel(dockviewApi, threadId);
    }
    dockviewApi.getPanel(threadId)?.api.setActive();
  }, [addThreadPanel, dockviewApi, layout, threadId, workspaceThreadIds, worktreeId]);

  useEffect(() => {
    if (!dockviewApi || !restoredRef.current || !workspaceThreadsById.has(threadId)) return;

    const existing = dockviewApi.getPanel(threadId);
    if (existing) {
      pendingPanelReferenceIdRef.current = null;
      existing.api.setActive();
      return;
    }

    addThreadPanel(dockviewApi, threadId)?.api.setActive();
  }, [addThreadPanel, dockviewApi, threadId, workspaceThreadsById]);

  useEffect(() => {
    if (!dockviewApi) return;

    const panels = [...dockviewApi.panels];
    for (const panel of panels) {
      const nextEntry = workspaceThreadsById.get(panel.id as ThreadId);
      if (!nextEntry) {
        panel.api.close();
        continue;
      }

      if (panel.title !== nextEntry.title) {
        panel.api.setTitle(nextEntry.title);
      }

      const currentParams = panel.api.getParameters<WorktreeDockPanelParams>();
      if (
        currentParams.threadId !== nextEntry.threadId ||
        currentParams.worktreeId !== nextEntry.worktreeId ||
        currentParams.title !== nextEntry.title
      ) {
        panel.api.updateParameters(buildThreadPanelParams(nextEntry));
      }
    }

    if (workspaceThreadsById.has(threadId)) {
      return;
    }

    const nextPanel = dockviewApi.activePanel ?? dockviewApi.panels[0];
    if (!nextPanel) {
      void navigate({ to: "/", replace: true });
      return;
    }

    void navigate({
      to: "/$threadId",
      params: { threadId: nextPanel.id as ThreadId },
      replace: true,
    });
  }, [dockviewApi, navigate, threadId, workspaceThreadsById]);

  useEffect(() => {
    if (!dockviewApi) return;

    const layoutDisposable = dockviewApi.onDidLayoutChange(() => {
      setLayout(worktreeId, dockviewApi.toJSON());
    });
    const activePanelDisposable = dockviewApi.onDidActivePanelChange((panel) => {
      const nextThreadId = panel?.id;
      if (!nextThreadId || nextThreadId === threadId) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId as ThreadId },
        replace: true,
      });
    });

    return () => {
      layoutDisposable.dispose();
      activePanelDisposable.dispose();
    };
  }, [dockviewApi, navigate, setLayout, threadId, worktreeId]);

  useEffect(() => {
    if (import.meta.env.MODE !== "test") {
      return;
    }

    if (dockviewApi) {
      window.__T3CODE_DOCKVIEW_API__ = dockviewApi;
    } else {
      delete window.__T3CODE_DOCKVIEW_API__;
    }

    return () => {
      if (window.__T3CODE_DOCKVIEW_API__ === dockviewApi) {
        delete window.__T3CODE_DOCKVIEW_API__;
      }
    };
  }, [dockviewApi]);

  useEffect(() => {
    const isTerminalFocused = (): boolean => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return false;
      if (activeElement.classList.contains("xterm-helper-textarea")) return true;
      return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
    };

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: Boolean(terminalState.terminalOpen),
        },
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        setTerminalOpen(!terminalState.terminalOpen);
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeProject,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    keybindings,
    runProjectScript,
    setTerminalOpen,
    splitTerminal,
    terminalState.activeTerminalId,
    terminalState.terminalOpen,
  ]);

  return (
    <div className="worktree-thread-dock flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            {activeProject?.name ? (
              <Badge variant="outline" className="min-w-0 shrink truncate">
                {activeProject.name}
              </Badge>
            ) : null}
            {activeThread?.branch ? (
              <Badge variant="outline" className="min-w-0 shrink truncate">
                {activeThread.branch}
              </Badge>
            ) : null}
            {activeProject?.name && !isGitRepo ? (
              <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
                No Git
              </Badge>
            ) : null}
          </div>
          <div className="@container/header-actions flex min-w-0 flex-1 items-center justify-end gap-2 @sm/header-actions:gap-3">
            {activeProject?.scripts ? (
              <ProjectScriptsControl
                scripts={activeProject.scripts}
                keybindings={keybindings}
                preferredScriptId={
                  activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
                }
                onRunScript={(script) => {
                  void runProjectScript(script);
                }}
                onAddScript={saveProjectScript}
                onUpdateScript={updateProjectScript}
                onDeleteScript={deleteProjectScript}
              />
            ) : null}
            {activeProject?.name ? (
              <OpenInPicker
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={gitCwd}
              />
            ) : null}
            {activeProject?.name ? (
              <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
            ) : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <DockviewReact
          className="h-full w-full"
          components={dockComponents}
          defaultRenderer="always"
          defaultTabComponent={DockThreadTab}
          disableFloatingGroups
          rightHeaderActionsComponent={rightHeaderActionsComponent}
          scrollbars="native"
          theme={resolvedTheme === "dark" ? themeDark : themeLight}
          onReady={(event: DockviewReadyEvent) => {
            setDockviewApi(event.api);
          }}
        />
      </div>

      {terminalState.terminalOpen && activeProject && activeThreadId ? (
        <ThreadTerminalDrawer
          key={activeThreadId}
          threadId={activeThreadId}
          cwd={gitCwd ?? activeProject.cwd}
          runtimeEnv={threadTerminalRuntimeEnv}
          height={terminalState.terminalHeight}
          terminalIds={terminalState.terminalIds}
          activeTerminalId={terminalState.activeTerminalId}
          terminalGroups={terminalState.terminalGroups}
          activeTerminalGroupId={terminalState.activeTerminalGroupId}
          focusRequestId={terminalFocusRequestId}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={setTerminalHeight}
        />
      ) : null}

      {!activeThread && (
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground/70">
          <div className="flex items-center gap-2">
            <ChevronRightIcon className="size-4" />
            <span>Select a thread to get started.</span>
          </div>
        </div>
      )}
    </div>
  );
}
