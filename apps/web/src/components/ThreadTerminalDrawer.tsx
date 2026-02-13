import { FitAddon } from "@xterm/addon-fit";
import { type NativeApi } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  extractTerminalLinks,
  isTerminalLinkActivation,
  preferredTerminalEditor,
  resolvePathLinkTarget,
} from "../terminal-links";
import { isTerminalClearShortcut } from "../terminal-shortcuts";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalLayout,
} from "../types";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height)
    ? height
    : DEFAULT_THREAD_TERMINAL_HEIGHT;
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
  const foreground =
    bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

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
  api: NativeApi;
  threadId: string;
  terminalId: string;
  cwd: string;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}

function TerminalViewport({
  api,
  threadId,
  terminalId,
  cwd,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

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
      fontFamily:
        '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const sendClearShortcut = async () => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data: "\u000c" });
      } catch (error) {
        writeSystemMessage(
          activeTerminal,
          error instanceof Error ? error.message : "Failed to clear terminal",
        );
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendClearShortcut();
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
              if (!isTerminalLinkActivation(event)) {
                return;
              }

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) {
                return;
              }

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
              void api.shell.openInEditor(target, preferredTerminalEditor()).catch((error) => {
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

    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.threadId !== threadId || event.terminalId !== terminalId) return;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;

      if (event.type === "output") {
        activeTerminal.write(event.data);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
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
  }, [api, autoFocus, cwd, terminalId, threadId]);

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
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
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
  }, [api, drawerHeight, resizeEpoch, terminalId, threadId]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden rounded-[4px]" />;
}

interface ThreadTerminalDrawerProps {
  api: NativeApi;
  threadId: string;
  cwd: string;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalLayout: ThreadTerminalLayout;
  splitTerminalIds: string[];
  focusRequestId: number;
  onSplitTerminal: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
}

export default function ThreadTerminalDrawer({
  api,
  threadId,
  cwd,
  height,
  terminalIds,
  activeTerminalId,
  terminalLayout,
  splitTerminalIds,
  focusRequestId,
  onSplitTerminal,
  onNewTerminal,
  onActiveTerminalChange,
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

  const resolvedSplitTerminalIds = useMemo(() => {
    if (terminalLayout !== "split") return [];
    const validSplitIds = [...new Set(splitTerminalIds)].filter((id) =>
      normalizedTerminalIds.includes(id),
    );
    if (validSplitIds.length >= 2) {
      return validSplitIds.slice(0, 2);
    }

    const fallbackPartner = normalizedTerminalIds.find((id) => id !== resolvedActiveTerminalId);
    if (!fallbackPartner) {
      return [];
    }
    return [resolvedActiveTerminalId, fallbackPartner];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, splitTerminalIds, terminalLayout]);

  const visibleTerminalIds =
    terminalLayout === "split" && resolvedSplitTerminalIds.length === 2
      ? resolvedSplitTerminalIds
      : [resolvedActiveTerminalId];

  const showTabBar = terminalLayout === "tabs" && normalizedTerminalIds.length > 1;

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
      className="thread-terminal-drawer flex shrink-0 flex-col border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="flex h-2 cursor-row-resize items-center justify-center"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      >
        <div className="h-px w-10 rounded-full bg-border/80" />
      </div>

      <div className="flex items-center gap-2 px-2 pb-1">
        {showTabBar ? (
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="inline-flex rounded-md border border-border/80 bg-muted/40 p-0.5">
              {normalizedTerminalIds.map((terminalId, index) => {
                const isActive = terminalId === resolvedActiveTerminalId;
                return (
                  <button
                    key={terminalId}
                    type="button"
                    className={`rounded px-2.5 py-1 text-xs transition-colors ${
                      isActive
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => onActiveTerminalChange(terminalId)}
                  >
                    {`Terminal ${index + 1}`}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-muted/30">
          <button
            type="button"
            className="px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:bg-accent"
            onClick={onSplitTerminal}
          >
            Split Terminal
          </button>
          <div className="h-5 w-px bg-border/80" />
          <button
            type="button"
            className="px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:bg-accent"
            onClick={onNewTerminal}
          >
            New Terminal
          </button>
        </div>
      </div>

      <div className="min-h-0 w-full flex-1 px-1.5 pb-1">
        {terminalLayout === "split" && visibleTerminalIds.length === 2 ? (
          <div className="grid h-full w-full grid-cols-2 gap-1">
            {visibleTerminalIds.map((terminalId) => (
              <TerminalViewport
                key={terminalId}
                api={api}
                threadId={threadId}
                terminalId={terminalId}
                cwd={cwd}
                focusRequestId={focusRequestId}
                autoFocus={terminalId === resolvedActiveTerminalId}
                resizeEpoch={resizeEpoch}
                drawerHeight={drawerHeight}
              />
            ))}
          </div>
        ) : (
          <TerminalViewport
            key={resolvedActiveTerminalId}
            api={api}
            threadId={threadId}
            terminalId={resolvedActiveTerminalId}
            cwd={cwd}
            focusRequestId={focusRequestId}
            autoFocus
            resizeEpoch={resizeEpoch}
            drawerHeight={drawerHeight}
          />
        )}
      </div>
    </aside>
  );
}
