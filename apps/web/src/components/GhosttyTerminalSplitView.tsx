/**
 * Mini Terminal Split View powered by libghostty (via ghostty-web WASM).
 *
 * This component demonstrates embedding Ghostty's battle-tested VT100 parser
 * (compiled to WebAssembly from the original Zig source) into a React-based
 * split terminal pane layout.
 *
 * Instead of xterm.js's JavaScript-based terminal emulation, this uses
 * libghostty-vt — the same core used by the native Ghostty terminal app —
 * providing superior Unicode handling, SIMD-optimized parsing, and proper
 * support for complex scripts (Devanagari, Arabic, etc.).
 *
 * Architecture:
 *   ghostty-web (npm) → WASM (libghostty-vt compiled from Zig) → Canvas renderer
 *   React component → manages split pane layout, focus, resize
 *   Server PTY → WebSocket → ghostty-web Terminal.write()
 */

import { init as initGhostty, Terminal, FitAddon, type ITheme } from "ghostty-web";
import {
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
  Split,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readNativeApi } from "~/nativeApi";
import type { ThreadId } from "@t3tools/contracts";
import {
  contrastSafeTerminalColor,
  normalizeAccentColor,
  resolveAccentColorRgba,
} from "../accentColor";

// ─── Ghostty WASM Initialization ────────────────────────────────────────────
// ghostty-web requires a one-time async init to load the WASM module.
// We track the promise globally so multiple components share the same load.

let ghosttyInitPromise: Promise<void> | null = null;
let ghosttyReady = false;

function ensureGhosttyInit(): Promise<void> {
  if (ghosttyReady) return Promise.resolve();
  if (!ghosttyInitPromise) {
    ghosttyInitPromise = initGhostty().then(() => {
      ghosttyReady = true;
    });
  }
  return ghosttyInitPromise;
}

// ─── Theme ──────────────────────────────────────────────────────────────────

const DARK_BG_HEX = "#0e1218";
const LIGHT_BG_HEX = "#ffffff";

function clampByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function mixHexWithWhite(hex: string, ratio: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const mr = clampByte(r + (255 - r) * ratio);
  const mg = clampByte(g + (255 - g) * ratio);
  const mb = clampByte(b + (255 - b) * ratio);
  return `#${mr.toString(16).padStart(2, "0")}${mg.toString(16).padStart(2, "0")}${mb.toString(16).padStart(2, "0")}`;
}

function ghosttyThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const rootStyles = getComputedStyle(document.documentElement);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");
  const accentColor = normalizeAccentColor(rootStyles.getPropertyValue("--accent-color"));
  const bgHex = isDark ? DARK_BG_HEX : LIGHT_BG_HEX;
  const terminalBlue = contrastSafeTerminalColor(accentColor, bgHex);
  const brightMix = isDark ? 0.3 : 0.18;
  const terminalBrightBlue = contrastSafeTerminalColor(
    mixHexWithWhite(accentColor, brightMix),
    bgHex,
  );
  const selectionBackground = resolveAccentColorRgba(accentColor, isDark ? 0.3 : 0.22);

  if (isDark) {
    return {
      background,
      foreground,
      cursor: terminalBrightBlue,
      selectionBackground,
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: terminalBlue,
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: terminalBrightBlue,
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: terminalBlue,
    selectionBackground,
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: terminalBlue,
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: terminalBrightBlue,
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_PANE_WIDTH_PX = 120;
const MAX_PANES = 4;
const MIN_CONTAINER_HEIGHT = 200;
const MAX_CONTAINER_HEIGHT = 600;
const DEFAULT_CONTAINER_HEIGHT = 350;

// ─── Types ──────────────────────────────────────────────────────────────────

interface SplitPane {
  id: string;
  terminalId: string;
}

// ─── Single Ghostty Terminal Pane ───────────────────────────────────────────

interface GhosttyPaneProps {
  threadId: ThreadId;
  terminalId: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  isActive: boolean;
  onFocus: () => void;
  onClose: () => void;
  resizeEpoch: number;
  containerHeight: number;
}

function GhosttyPane({
  threadId,
  terminalId,
  cwd,
  runtimeEnv,
  isActive,
  onFocus,
  onClose,
  resizeEpoch,
  containerHeight,
}: GhosttyPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Initialize ghostty-web terminal
  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const setup = async () => {
      try {
        // Ensure WASM is loaded
        await ensureGhosttyInit();
        if (disposed) return;

        const fitAddon = new FitAddon();
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          scrollback: 5_000,
          fontFamily:
            '"Geist Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          theme: ghosttyThemeFromApp(),
        });

        terminal.loadAddon(fitAddon);
        terminal.open(mount);
        fitAddon.fit();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        if (disposed) {
          terminal.dispose();
          return;
        }

        setStatus("ready");

        // Connect to backend PTY
        const api = readNativeApi();
        if (!api) return;

        // Handle user input → send to PTY
        const inputDisposable = terminal.onData((data) => {
          void api.terminal
            .write({ threadId, terminalId, data })
            .catch((err) => {
              terminal.write(
                `\r\n[ghostty] ${err instanceof Error ? err.message : "Write failed"}\r\n`,
              );
            });
        });

        // Listen for PTY output → write to terminal
        const unsubscribe = api.terminal.onEvent((event) => {
          if (event.threadId !== threadId || event.terminalId !== terminalId) return;
          const activeTerminal = terminalRef.current;
          if (!activeTerminal) return;

          switch (event.type) {
            case "output":
              activeTerminal.write(event.data);
              break;
            case "started":
            case "restarted":
              activeTerminal.write("\u001bc");
              if (event.snapshot.history.length > 0) {
                activeTerminal.write(event.snapshot.history);
              }
              break;
            case "cleared":
              activeTerminal.clear();
              activeTerminal.write("\u001bc");
              break;
            case "error":
              activeTerminal.write(`\r\n[ghostty] ${event.message}\r\n`);
              break;
            case "exited": {
              const details = [
                typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
                typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
              ]
                .filter((v): v is string => v !== null)
                .join(", ");
              activeTerminal.write(
                `\r\n[ghostty] ${details ? `Process exited (${details})` : "Process exited"}\r\n`,
              );
              break;
            }
          }
        });

        // Open the terminal session on the server
        try {
          fitAddon.fit();
          const snapshot = await api.terminal.open({
            threadId,
            terminalId,
            cwd,
            cols: terminal.cols,
            rows: terminal.rows,
            ...(runtimeEnv ? { env: runtimeEnv } : {}),
          });
          if (disposed) return;
          terminal.write("\u001bc");
          if (snapshot.history.length > 0) {
            terminal.write(snapshot.history);
          }
          if (isActive) {
            window.requestAnimationFrame(() => terminal.focus());
          }
        } catch (err) {
          if (disposed) return;
          terminal.write(
            `\r\n[ghostty] ${err instanceof Error ? err.message : "Failed to open terminal"}\r\n`,
          );
        }

        // Theme observer
        const themeObserver = new MutationObserver(() => {
          const t = terminalRef.current;
          if (!t) return;
          t.options.theme = ghosttyThemeFromApp();
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class", "style"],
        });

        // Cleanup on unmount
        return () => {
          disposed = true;
          unsubscribe();
          inputDisposable.dispose();
          themeObserver.disconnect();
          terminalRef.current = null;
          fitAddonRef.current = null;
          terminal.dispose();
        };
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          console.error("[ghostty-web] Init failed:", err);
        }
      }
    };

    const cleanupPromise = setup();

    return () => {
      disposed = true;
      void cleanupPromise?.then((cleanup) => cleanup?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, runtimeEnv, terminalId, threadId]);

  // Handle focus
  useEffect(() => {
    if (!isActive) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => terminal.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isActive]);

  // Handle resize
  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;

    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.scrollToBottom();
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [containerHeight, resizeEpoch, terminalId, threadId]);

  return (
    <div
      className={`ghostty-pane group relative flex h-full min-w-0 flex-1 flex-col overflow-hidden ${
        isActive
          ? "ring-1 ring-accent/50"
          : "ring-1 ring-border/30 hover:ring-border/60"
      }`}
      style={{ minWidth: `${MIN_PANE_WIDTH_PX}px` }}
      onMouseDown={onFocus}
    >
      {/* Pane header */}
      <div
        className={`flex h-6 shrink-0 items-center justify-between px-1.5 text-[10px] ${
          isActive
            ? "bg-accent/10 text-foreground"
            : "bg-muted/30 text-muted-foreground"
        }`}
      >
        <div className="flex items-center gap-1">
          <TerminalIcon className="size-2.5" />
          <span className="font-medium tracking-wide">
            {status === "loading" ? "Loading WASM…" : status === "error" ? "Error" : "ghostty"}
          </span>
          {status === "ready" && (
            <span className="rounded bg-emerald-500/15 px-1 py-px text-[8px] font-semibold uppercase tracking-widest text-emerald-500">
              libghostty
            </span>
          )}
        </div>
        <button
          type="button"
          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close pane"
        >
          <X className="size-2.5" />
        </button>
      </div>

      {/* Terminal canvas area */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

// ─── Split Divider ──────────────────────────────────────────────────────────

interface SplitDividerProps {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

function SplitDivider({ onPointerDown, onPointerMove, onPointerUp }: SplitDividerProps) {
  return (
    <div
      className="flex w-1.5 shrink-0 cursor-col-resize items-center justify-center transition-colors hover:bg-accent/30"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <GripVertical className="size-3 text-border" />
    </div>
  );
}

// ─── Main Split View Component ──────────────────────────────────────────────

export interface GhosttyTerminalSplitViewProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
}

let nextPaneCounter = 0;
function createPaneId(): string {
  nextPaneCounter += 1;
  return `ghostty-pane-${nextPaneCounter}-${Date.now().toString(36)}`;
}

export default function GhosttyTerminalSplitView({
  threadId,
  cwd,
  runtimeEnv,
}: GhosttyTerminalSplitViewProps) {
  const [panes, setPanes] = useState<SplitPane[]>(() => {
    const id = createPaneId();
    return [{ id, terminalId: `ghostty-${id}` }];
  });
  const [activePaneId, setActivePaneId] = useState<string>(() => panes[0]!.id);
  const [containerHeight, setContainerHeight] = useState(DEFAULT_CONTAINER_HEIGHT);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const canSplit = panes.length < MAX_PANES;

  // ─── Pane management ────────────────────────────────────────────────

  const handleSplit = useCallback(() => {
    if (!canSplit) return;
    const id = createPaneId();
    const newPane: SplitPane = { id, terminalId: `ghostty-${id}` };
    setPanes((prev) => [...prev, newPane]);
    setActivePaneId(id);
    setResizeEpoch((e) => e + 1);
  }, [canSplit]);

  const handleClosePane = useCallback(
    (paneId: string) => {
      setPanes((prev) => {
        if (prev.length <= 1) return prev; // keep at least one
        const next = prev.filter((p) => p.id !== paneId);
        if (activePaneId === paneId) {
          setActivePaneId(next[0]?.id ?? "");
        }
        setResizeEpoch((e) => e + 1);
        return next;
      });
    },
    [activePaneId],
  );

  // ─── Vertical resize (container height) ─────────────────────────────

  const handleResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeStateRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: containerHeight,
    };
  }, [containerHeight]);

  const handleResizePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    const nextHeight = Math.min(
      MAX_CONTAINER_HEIGHT,
      Math.max(MIN_CONTAINER_HEIGHT, state.startHeight + (state.startY - e.clientY)),
    );
    setContainerHeight(nextHeight);
  }, []);

  const handleResizePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    resizeStateRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setResizeEpoch((v) => v + 1);
  }, []);

  // ─── Window resize ──────────────────────────────────────────────────

  useEffect(() => {
    const onResize = () => setResizeEpoch((v) => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ─── Keyboard shortcut for splitting ────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Shift + D to split
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "d") {
        e.preventDefault();
        handleSplit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSplit]);

  // ─── Pane label map ─────────────────────────────────────────────────

  const paneLabelMap = useMemo(
    () => new Map(panes.map((p, i) => [p.id, `Pane ${i + 1}`])),
    [panes],
  );

  if (isCollapsed) {
    return (
      <div className="border-t border-border/60">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={() => setIsCollapsed(false)}
        >
          <Maximize2 className="size-3" />
          <TerminalIcon className="size-3" />
          <span className="font-medium">Ghostty Split View</span>
          <span className="rounded bg-accent/30 px-1 py-px text-[9px]">
            {panes.length} {panes.length === 1 ? "pane" : "panes"}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="ghostty-split-view relative flex flex-col border-t border-border/60"
      style={{ height: `${containerHeight}px` }}
    >
      {/* Resize handle (top edge) */}
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      />

      {/* Toolbar */}
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border/40 bg-muted/20 px-2">
        <div className="flex items-center gap-1.5">
          <TerminalIcon className="size-3 text-muted-foreground" />
          <span className="text-[11px] font-semibold tracking-wide text-foreground/80">
            Ghostty Split View
          </span>
          <span className="rounded bg-gradient-to-r from-violet-500/20 to-cyan-500/20 px-1.5 py-px text-[8px] font-bold uppercase tracking-widest text-violet-400">
            libghostty
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          {/* Pane tabs */}
          {panes.length > 1 &&
            panes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  pane.id === activePaneId
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}
                onClick={() => setActivePaneId(pane.id)}
              >
                {paneLabelMap.get(pane.id) ?? "Pane"}
              </button>
            ))}

          <div className="mx-1 h-3.5 w-px bg-border/60" />

          {/* Split button */}
          <button
            type="button"
            className={`rounded p-1 text-muted-foreground transition-colors ${
              canSplit
                ? "hover:bg-accent/60 hover:text-foreground"
                : "cursor-not-allowed opacity-40"
            }`}
            onClick={handleSplit}
            disabled={!canSplit}
            title={canSplit ? `Split (max ${MAX_PANES})` : `Max ${MAX_PANES} panes`}
          >
            <Split className="size-3" />
          </button>

          {/* Add new pane */}
          <button
            type="button"
            className={`rounded p-1 text-muted-foreground transition-colors ${
              canSplit
                ? "hover:bg-accent/60 hover:text-foreground"
                : "cursor-not-allowed opacity-40"
            }`}
            onClick={handleSplit}
            disabled={!canSplit}
            title="New pane"
          >
            <Plus className="size-3" />
          </button>

          {/* Collapse */}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={() => setIsCollapsed(true)}
            title="Collapse"
          >
            <Minimize2 className="size-3" />
          </button>
        </div>
      </div>

      {/* Split pane container */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {panes.map((pane, index) => (
          <div key={pane.id} className="flex min-w-0 flex-1">
            {index > 0 && (
              <SplitDivider
                onPointerDown={() => {}}
                onPointerMove={() => {}}
                onPointerUp={() => {}}
              />
            )}
            <GhosttyPane
              threadId={threadId}
              terminalId={pane.terminalId}
              cwd={cwd}
              {...(runtimeEnv ? { runtimeEnv } : {})}
              isActive={pane.id === activePaneId}
              onFocus={() => setActivePaneId(pane.id)}
              onClose={() => handleClosePane(pane.id)}
              resizeEpoch={resizeEpoch}
              containerHeight={containerHeight}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
