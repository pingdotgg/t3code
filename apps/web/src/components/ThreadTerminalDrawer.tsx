import { FitAddon } from "@xterm/addon-fit";
import { Plus, SquareSplitHorizontal, TerminalSquare, Trash2, XIcon } from "lucide-react";
import { type ThreadId } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { openInPreferredEditor } from "../editorPreferences";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
} from "../terminal-links";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_THREAD_TERMINAL_COUNT,
  type ThreadTerminalGroup,
} from "../types";
import { readNativeApi } from "~/nativeApi";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}

function TerminalViewport({
  threadId,
  terminalId,
  cwd,
  runtimeEnv,
  onSessionExited,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onSessionExitedRef = useRef(onSessionExited);
  const hasHandledExitRef = useRef(false);

  useEffect(() => {
    onSessionExitedRef.current = onSessionExited;
  }, [onSessionExited]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const line = activeTerminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }

        const lineText = line.translateToString(true);
        const matches = extractTerminalLinks(lineText);
        if (matches.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          matches.map((match) => ({
            text: match.text,
            range: {
              start: { x: match.start + 1, y: bufferLineNumber },
              end: { x: match.end, y: bufferLineNumber },
            },
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const openTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        activeFitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        activeTerminal.write("\u001bc");
        if (snapshot.history.length > 0) {
          activeTerminal.write(snapshot.history);
        }
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const unsubscribe = api?.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        activeTerminal.write(event.data);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        activeTerminal.write("\u001bc");
        if (event.snapshot.history.length > 0) {
          activeTerminal.write(event.snapshot.history);
        }
        return;
      }

      if (event.type === "cleared") {
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      if (event.type === "exited") {
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          activeTerminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (hasHandledExitRef.current) {
          return;
        }
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          onSessionExitedRef.current();
        }, 0);
      }
    });

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    }, 30);
    void openTerminal();

    return () => {
      disposed = true;
      window.clearTimeout(fitTimer);
      unsubscribe();
      inputDisposable.dispose();
      terminalLinksDisposable.dispose();
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return <div ref={containerRef} className="h-full w-full overflow-hidden rounded-[4px]" />;
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
}: ThreadTerminalDrawerProps) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedTerminalLimit = normalizedTerminalIds.length >= MAX_THREAD_TERMINAL_COUNT;
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
      ),
    [normalizedTerminalIds],
  );
  const splitTerminalActionLabel = hasReachedTerminalLimit
    ? `Split Terminal (max ${MAX_THREAD_TERMINAL_COUNT})`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = hasReachedTerminalLimit
    ? `New Terminal (max ${MAX_THREAD_TERMINAL_COUNT})`
    : newShortcutLabel
      ? `New Terminal (${newShortcutLabel})`
      : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    onSplitTerminal();
  }, [hasReachedTerminalLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    onNewTerminal();
  }, [hasReachedTerminalLimit, onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    setDrawerHeight(clampedHeight);
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeight(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  return (
    <aside
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedTerminalLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedTerminalLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={{
                  gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                }}
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 border-l first:border-l-0 ${
                      terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full p-1">
                      <TerminalViewport
                        threadId={threadId}
                        terminalId={terminalId}
                        cwd={cwd}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        resizeEpoch={resizeEpoch}
                        drawerHeight={drawerHeight}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedTerminalLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedTerminalLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex w-full items-center rounded px-1 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          {terminalGroup.terminalIds.length > 1
                            ? `Split ${groupIndex + 1}`
                            : `Terminal ${groupIndex + 1}`}
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
