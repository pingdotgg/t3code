import * as NodeModule from "node:module";

import { RGBA } from "@opentui/core";
import { usePaste } from "@opentui/react";
import type { ThreadId } from "@t3tools/contracts";
import * as React from "react";

import type { TuiClient } from "../connection.ts";
import {
  encodeTerminalPaste,
  readTerminalFrame,
  readTerminalViewport,
  type TermSegment,
} from "../terminalView.ts";
import { ansi, THEME, usePalette } from "../theme.ts";

// The embedded terminal pane (mirrors apps/web/src/components/ThreadTerminalDrawer.tsx).
// It owns a headless xterm emulator — the same engine as the web — fed by the
// thread's PTY stream, and renders the grid into OpenTUI with the terminal's own
// colours.

// @xterm/headless ships as CommonJS, so load it via createRequire (matching the
// repo's node-pty pattern) rather than a named ESM import. Works under Bun.
const { Terminal } = NodeModule.createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");
type XTerm = InstanceType<typeof Terminal>;

/** A scrollback navigation request routed from the key handler to the active pane. */
export type TerminalScrollAction = "line-up" | "line-down" | "page-up" | "page-down" | "bottom";

/** Structural shape of OpenTUI's mouse event — only the scroll info is needed here. */
interface TermWheelEvent {
  readonly scroll?: {
    readonly direction: "up" | "down" | "left" | "right";
    readonly delta: number;
  };
}

/** Replay at most this many bytes of terminal history on attach (keeps it fast). */
const TERMINAL_HISTORY_TAIL = 128 * 1024;

export interface TerminalInfo {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly title: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/** Render one styled terminal segment, applying fg/bg + bold/underline/inverse. */
function renderSegment(segment: TermSegment, key: number): React.ReactNode {
  // Default cells inherit the terminal's own fg/bg; inverse swaps them so the
  // cursor cell and reverse-video runs read correctly on any theme.
  const fg = segment.inverse
    ? (segment.backgroundColor ?? THEME.bg)
    : (segment.color ?? THEME.text);
  const bg = segment.inverse ? (segment.color ?? THEME.text) : segment.backgroundColor;
  let node: React.ReactNode = segment.text;
  if (segment.href) node = <a href={segment.href}>{node}</a>;
  if (segment.underline || segment.href) node = <u>{node}</u>;
  if (segment.italic) node = <em>{node}</em>;
  if (segment.bold) node = <strong>{node}</strong>;
  const style: { fg?: string | RGBA; bg?: string | RGBA } = {};
  if (fg) style.fg = fg;
  if (bg) style.bg = bg;
  return (
    <span key={key} {...style}>
      {node}
    </span>
  );
}

/**
 * One terminal's headless xterm + live subscription. Every tab's pane stays
 * MOUNTED while the drawer is open, so background terminals keep buffering their
 * PTY output — switching tabs (flipping `visible`) is instant and preserves the
 * live screen instead of resetting and replaying history. Only the visible pane
 * paints; hidden panes still write to their buffer but skip the repaint.
 */
const TerminalPane = React.memo(function TerminalPane({
  client,
  info,
  cols,
  rows,
  visible,
  focused,
  copyRef,
  scrollRef,
}: {
  readonly client: TuiClient;
  readonly info: TerminalInfo;
  readonly cols: number;
  readonly rows: number;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly copyRef: React.MutableRefObject<(() => string) | null>;
  readonly scrollRef: React.MutableRefObject<((action: TerminalScrollAction) => void) | null>;
}): React.ReactNode {
  const safeCols = Math.max(2, cols);
  const safeRows = Math.max(2, rows);
  const termRef = React.useRef<XTerm | null>(null);
  // Lines scrolled up from the live tail (0 = tail). A ref, not state, so the
  // wheel/key handlers read the latest value without a re-render race; `bump()`
  // triggers the repaint.
  const scrollOffsetRef = React.useRef(0);
  const scheduled = React.useRef(false);
  const renderTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  if (!termRef.current) {
    termRef.current = new Terminal({
      cols: safeCols,
      rows: safeRows,
      allowProposedApi: true,
      scrollback: 2000,
    });
  }
  const term = termRef.current;

  React.useEffect(
    () => () => {
      if (renderTimer.current !== null) clearTimeout(renderTimer.current);
      termRef.current?.dispose();
      termRef.current = null;
    },
    [],
  );

  // Scroll the emulator's scrollback. UP moves into history (offset grows),
  // clamped to the buffered scrollback; `bottom` snaps back to the live tail.
  const scrollBy = React.useCallback(
    (action: TerminalScrollAction) => {
      const active = termRef.current?.buffer.active;
      if (!active) return;
      const max = active.baseY;
      const page = Math.max(1, safeRows - 1);
      const cur = scrollOffsetRef.current;
      const next = Math.max(
        0,
        Math.min(
          max,
          action === "line-up"
            ? cur + 1
            : action === "line-down"
              ? cur - 1
              : action === "page-up"
                ? cur + page
                : action === "page-down"
                  ? cur - page
                  : 0, // "bottom"
        ),
      );
      if (next !== scrollOffsetRef.current) {
        scrollOffsetRef.current = next;
        bump();
      }
    },
    [safeRows],
  );

  const handleWheel = React.useCallback((event: TermWheelEvent) => {
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    const active = termRef.current?.buffer.active;
    if (!active) return;
    const next = Math.max(
      0,
      Math.min(active.baseY, scrollOffsetRef.current + (direction === "up" ? 3 : -3)),
    );
    if (next !== scrollOffsetRef.current) {
      scrollOffsetRef.current = next;
      bump();
    }
  }, []);

  // Route key-driven scrolling to the visible pane (mirrors the copy handle).
  React.useEffect(() => {
    if (!visible) return;
    scrollRef.current = scrollBy;
    return () => {
      if (scrollRef.current === scrollBy) scrollRef.current = null;
    };
  }, [visible, scrollRef, scrollBy]);

  // Expose the viewport text for ^O copy while this is the visible terminal.
  React.useEffect(() => {
    if (!visible) return;
    const getter = () => readTerminalViewport(term);
    copyRef.current = getter;
    return () => {
      if (copyRef.current === getter) copyRef.current = null;
    };
  }, [visible, copyRef, term]);

  // Forward a paste to the PTY while this terminal is focused (the prompt editor
  // handles its own paste). Wrap in bracketed-paste markers when the running
  // program asked for them, so multi-line pastes don't auto-execute line by line.
  usePaste((event) => {
    if (!focused) return;
    const text = new TextDecoder().decode(event.bytes);
    if (text.length === 0) return;
    const data = encodeTerminalPaste(text, term.modes.bracketedPasteMode);
    void client.terminalWrite(info.threadId, info.terminalId, data).catch(() => {});
  });

  React.useEffect(() => {
    if (term.cols !== safeCols || term.rows !== safeRows) term.resize(safeCols, safeRows);
    // Keep the local buffer shaped for every pane, but only tell the server about
    // the visible one — background tabs needn't trigger N PTY resizes per window
    // resize; a hidden pane resyncs when it becomes visible (visible is a dep).
    if (visible) {
      void client
        .terminalResize(info.threadId, info.terminalId, safeCols, safeRows)
        .catch(() => {});
    }
  }, [safeCols, safeRows, visible]);

  React.useEffect(() => {
    const scheduleRender = () => {
      // Hidden panes still buffer output (term.write above) but don't repaint.
      if (!visibleRef.current || scheduled.current) return;
      scheduled.current = true;
      renderTimer.current = setTimeout(() => {
        renderTimer.current = null;
        scheduled.current = false;
        bump();
      }, 16);
    };
    const unsub = client.subscribeTerminal(
      {
        threadId: info.threadId,
        terminalId: info.terminalId,
        cwd: info.cwd,
        worktreePath: info.worktreePath,
        cols: safeCols,
        rows: safeRows,
      },
      (event) => {
        if (event.type === "snapshot" || event.type === "restarted") {
          term.reset();
          scrollOffsetRef.current = 0;
          const history = event.snapshot.history;
          term.write(
            history.length > TERMINAL_HISTORY_TAIL
              ? history.slice(history.length - TERMINAL_HISTORY_TAIL)
              : history,
            scheduleRender,
          );
        } else if (event.type === "cleared") {
          term.reset();
          scrollOffsetRef.current = 0;
          scheduleRender();
        } else if (event.type === "output") {
          term.write(event.data, scheduleRender);
        } else if (event.type === "exited") {
          term.write("\r\n[process exited]\r\n", scheduleRender);
        } else if (event.type === "error") {
          term.write(`\r\n[terminal error: ${event.message}]\r\n`, scheduleRender);
        }
      },
    );
    return () => {
      unsub();
    };
  }, [info.threadId, info.terminalId]);

  // Repaint once when this pane becomes visible — its buffer may have advanced
  // while it was hidden (no repaints fired).
  React.useEffect(() => {
    if (visible) bump();
  }, [visible]);

  if (!visible) return null;
  const frame = readTerminalFrame(term, scrollOffsetRef.current);
  const scrolled = frame.scrollOffset > 0;
  // When the indicator line is shown it takes a row; drop the newest rendered
  // row so the pane's height stays constant (the indicator replaces the tail).
  const bodyRows = scrolled ? frame.rows.slice(0, Math.max(0, frame.rows.length - 1)) : frame.rows;
  return (
    <box flexDirection="column" flexGrow={1} onMouseScroll={handleWheel}>
      {scrolled ? (
        <text>
          <span fg={ansi("yellow")}>
            {`▲ scrollback −${frame.scrollOffset}/${frame.maxScroll} · ⇧PgUp/PgDn · type to return`}
          </span>
        </text>
      ) : null}
      {bodyRows.map((segments, index) => (
        <text key={index}>
          {segments.length === 0 ? " " : segments.map((segment, i) => renderSegment(segment, i))}
        </text>
      ))}
    </box>
  );
});

export const ThreadTerminalDrawer = React.memo(function ThreadTerminalDrawer({
  client,
  info,
  cols,
  rows,
  focused,
  copyRef,
  scrollRef,
  tabIds,
  activeTabId,
  onSelectTab,
  onNewTab,
  onCloseTab,
}: {
  readonly client: TuiClient;
  /** The active terminal's info — its non-id fields (thread/cwd/title) are shared. */
  readonly info: TerminalInfo;
  readonly cols: number;
  readonly rows: number;
  /** Whether keystrokes are routed to the active terminal (drives the focus affordance). */
  readonly focused: boolean;
  /** Filled with a getter for the viewport text so the app can copy it (OSC 52). */
  readonly copyRef: React.MutableRefObject<(() => string) | null>;
  /** Routes key-driven scrollback navigation to the active pane. */
  readonly scrollRef: React.MutableRefObject<((action: TerminalScrollAction) => void) | null>;
  /** This thread's terminal tabs + the active one, for the tab bar. */
  readonly tabIds: ReadonlyArray<string>;
  readonly activeTabId: string;
  readonly onSelectTab: (id: string) => void;
  readonly onNewTab: () => void;
  readonly onCloseTab: (id: string) => void;
}): React.ReactNode {
  const palette = usePalette();
  const safeRows = Math.max(2, rows);
  return (
    <box
      flexDirection="column"
      height={safeRows + 4}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={focused ? palette.accent : palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={focused ? palette.accent : ansi("yellow")}>{`Terminal · ${info.title}`}</span>
        <span fg={palette.dim}>
          {focused
            ? "  ·  ^P prompt · ^E close · ^↑/^↓ resize · ^O copy · paste ✓"
            : "  ·  ^P focus · ^E close"}
        </span>
      </text>
      {/* Terminal tabs (the TUI's terminal groups): click a number to switch, ✕
          to close the active one, + to open another shell on this thread. */}
      <box flexDirection="row" flexShrink={0}>
        {tabIds.map((id, index) => {
          const active = id === activeTabId;
          return (
            <box key={id} flexDirection="row" marginRight={1} flexShrink={0}>
              <box onMouseDown={() => onSelectTab(id)}>
                <text>
                  <span fg={active ? palette.accent : palette.dim}>{active ? "▸" : " "}</span>
                  <span fg={active ? palette.text : palette.dim}>{` ${index + 1}`}</span>
                </text>
              </box>
              {active && tabIds.length > 1 ? (
                <box onMouseDown={() => onCloseTab(id)}>
                  <text fg={palette.dim}>{" ✕"}</text>
                </box>
              ) : null}
            </box>
          );
        })}
        <box onMouseDown={onNewTab}>
          <text fg={palette.dim}>{"+ new"}</text>
        </box>
      </box>
      {/* Every tab's pane stays mounted so background terminals keep buffering;
          only the active one paints, so switching is instant and lossless. */}
      {tabIds.map((id) => (
        <TerminalPane
          key={`${info.threadId}:${id}`}
          client={client}
          info={{ ...info, terminalId: id }}
          cols={cols}
          rows={rows}
          visible={id === activeTabId}
          focused={focused && id === activeTabId}
          copyRef={copyRef}
          scrollRef={scrollRef}
        />
      ))}
    </box>
  );
});
