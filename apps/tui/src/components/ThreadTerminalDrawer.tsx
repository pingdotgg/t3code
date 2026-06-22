import { createRequire } from "node:module";

import { RGBA } from "@opentui/core";
import { usePaste } from "@opentui/react";
import type { ThreadId } from "@t3tools/contracts";
import * as React from "react";

import type { TuiClient } from "../connection.ts";
import { readTerminalFrame, readTerminalViewport, type TermSegment } from "../terminalView.ts";
import { ansi, THEME, usePalette } from "../theme.ts";

// The embedded terminal pane (mirrors apps/web/src/components/ThreadTerminalDrawer.tsx).
// It owns a headless xterm emulator — the same engine as the web — fed by the
// thread's PTY stream, and renders the grid into OpenTUI with the terminal's own
// colours.

// @xterm/headless ships as CommonJS, so load it via createRequire (matching the
// repo's node-pty pattern) rather than a named ESM import. Works under Bun.
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");
type XTerm = InstanceType<typeof Terminal>;

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
  const fg = segment.inverse ? (segment.backgroundColor ?? THEME.bg) : (segment.color ?? THEME.text);
  const bg = segment.inverse ? (segment.color ?? THEME.text) : segment.backgroundColor;
  let node: React.ReactNode = segment.text;
  if (segment.underline) node = <u>{node}</u>;
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

export const ThreadTerminalDrawer = React.memo(function ThreadTerminalDrawer({
  client,
  info,
  cols,
  rows,
  focused,
  copyRef,
  tabIds,
  activeTabId,
  onSelectTab,
  onNewTab,
  onCloseTab,
}: {
  readonly client: TuiClient;
  readonly info: TerminalInfo;
  readonly cols: number;
  readonly rows: number;
  /** Whether keystrokes are routed to this terminal (drives the focus affordance). */
  readonly focused: boolean;
  /** Filled with a getter for the viewport text so the app can copy it (OSC 52). */
  readonly copyRef: React.MutableRefObject<(() => string) | null>;
  /** This thread's terminal tabs + the active one, for the tab bar. */
  readonly tabIds: ReadonlyArray<string>;
  readonly activeTabId: string;
  readonly onSelectTab: (id: string) => void;
  readonly onNewTab: () => void;
  readonly onCloseTab: (id: string) => void;
}): React.ReactNode {
  const palette = usePalette();
  const safeCols = Math.max(2, cols);
  const safeRows = Math.max(2, rows);
  const termRef = React.useRef<XTerm | null>(null);
  const scheduled = React.useRef(false);
  const renderTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Expose the viewport text so the app can copy it to the clipboard.
  React.useEffect(() => {
    copyRef.current = () => readTerminalViewport(term);
    return () => {
      copyRef.current = null;
    };
  }, [copyRef, term]);

  // Forward a paste to the PTY while the terminal is focused (the prompt editor
  // handles its own paste). Wrap in bracketed-paste markers when the running
  // program asked for them, so multi-line pastes don't auto-execute line by line.
  usePaste((event) => {
    if (!focused) return;
    const text = new TextDecoder().decode(event.bytes);
    if (text.length === 0) return;
    const data = term.modes.bracketedPasteMode ? `[200~${text}[201~` : text;
    void client.terminalWrite(info.threadId, info.terminalId, data).catch(() => {});
  });

  React.useEffect(() => {
    if (term.cols !== safeCols || term.rows !== safeRows) term.resize(safeCols, safeRows);
    void client.terminalResize(info.threadId, info.terminalId, safeCols, safeRows).catch(() => {});
  }, [safeCols, safeRows]);

  React.useEffect(() => {
    const scheduleRender = () => {
      if (scheduled.current) return;
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
          const history = event.snapshot.history;
          term.write(
            history.length > TERMINAL_HISTORY_TAIL
              ? history.slice(history.length - TERMINAL_HISTORY_TAIL)
              : history,
            scheduleRender,
          );
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

  const frame = readTerminalFrame(term);
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
      {frame.rows.map((segments, index) => (
        <text key={index}>
          {segments.length === 0 ? " " : segments.map((segment, i) => renderSegment(segment, i))}
        </text>
      ))}
    </box>
  );
});
