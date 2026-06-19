import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  DEFAULT_TERMINAL_ID,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { Box, render, Text, useInput } from "ink";
import * as React from "react";

import { derivePendingApprovals, type PendingApproval } from "./approvals.ts";
import { readTerminalFrame, type TermSegment } from "./terminalView.ts";
import {
  relativeTime,
  resolveProjectStatus,
  resolveThreadStatus,
  sessionStatusColor,
  type ThreadStatus,
} from "./theme.ts";

// @xterm/headless ships as CommonJS, so load it via createRequire (matching the
// repo's node-pty pattern) rather than a named ESM import.
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");
type XTerm = InstanceType<typeof Terminal>;
import type {
  OrchestrationShellSnapshot,
  OrchestrationThread,
  TuiClient,
} from "./runtime.ts";

const h = React.createElement;

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

/** Detach key for the terminal passthrough (Ctrl-Q). */
const TERMINAL_DETACH_BYTE = 0x11;

/** Switch the terminal into the alternate screen buffer (fullscreen) and back. */
const enterFullscreen = () => process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
const leaveFullscreen = () => process.stdout.write("\x1b[?1049l");

/**
 * Enable/disable mouse reporting. 1000 = button press/release, 1002 = motion
 * while a button is held (for divider dragging), 1006 = SGR encoding. We also
 * parse the legacy X10 encoding in case a terminal/multiplexer falls back to it.
 */
const enableMouse = () => process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
const disableMouse = () => process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");

/** Width of the thread-list pane. */
const LIST_PANE_WIDTH = 34;

/** Conversation lines scrolled per mouse-wheel notch (the usual terminal step). */
const WHEEL_LINES = 6;

/** Replay at most this many bytes of terminal history on attach (keeps it fast). */
const TERMINAL_HISTORY_TAIL = 128 * 1024;

/** Matches the leftover of an SGR mouse report so it never lands in the prompt. */
const MOUSE_SEQUENCE = /<\d+;\d+;\d+[Mm]/;

/** Opt-in: dump raw stdin bytes (hex) so we can see what the wheel emits. */
const INPUT_DEBUG = Boolean(process.env.T3CODE_TUI_DEBUG);
const INPUT_DEBUG_PATH = joinPath(tmpdir(), "t3-tui-input.log");
const logInputBytes = (chunk: Buffer | string) => {
  if (!INPUT_DEBUG) return;
  try {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    appendFileSync(
      INPUT_DEBUG_PATH,
      `${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}\n`,
    );
  } catch {
    // best effort
  }
};

/**
 * Map an SGR/X10 mouse button code to a scroll direction. Wheel/scroll events
 * set bit 6 (64); the low bits encode the axis+direction (64 up, 65 down, 66
 * left, 67 right) and bits 2-4 are shift/alt/ctrl modifiers, which we strip.
 * Both wheel axes are treated as vertical scroll since that's all the UI scrolls.
 */
function wheelDirection(button: number): "up" | "down" | null {
  const base = button & ~(4 | 8 | 16); // strip shift/alt/ctrl
  // 64/65 are the standard vertical wheel; 66/67 are the "other" axis some
  // devices report scroll on — both mapped to vertical scroll.
  if (base === 64 || base === 66) return "up";
  if (base === 65 || base === 67) return "down";
  return null;
}

interface MouseHandlers {
  readonly onWheel: (direction: "up" | "down", column: number) => void;
  /** Left-button press at a 1-based (column, row). */
  readonly onPress: (column: number, row: number) => void;
  /** Left-button motion (drag) at a 1-based (column, row). */
  readonly onDrag: (column: number, row: number) => void;
  /** Any button release. */
  readonly onRelease: (column: number, row: number) => void;
}

/** Decode one mouse report (button code already de-offset for X10). */
function dispatchMouse(
  button: number,
  column: number,
  row: number,
  isPress: boolean,
  handlers: MouseHandlers,
): void {
  const direction = wheelDirection(button);
  if (direction) {
    handlers.onWheel(direction, column);
    return;
  }
  if (!isPress) {
    handlers.onRelease(column, row); // SGR release (lowercase m)
    return;
  }
  const baseButton = button & 3;
  if (baseButton === 3) {
    handlers.onRelease(column, row); // X10 release
    return;
  }
  if ((button & 32) !== 0) {
    if (baseButton === 0) handlers.onDrag(column, row); // left-button drag
    return;
  }
  if (baseButton === 0) handlers.onPress(column, row); // left-button press
}

/**
 * Parse both SGR and legacy X10 mouse reports out of a stdin chunk and dispatch
 * wheel + press/drag/release events. Ink delivers the chunk as a string, so we
 * scan via `charCodeAt` rather than Buffer indexing.
 */
function parseMouse(chunk: Buffer | string, handlers: MouseHandlers): void {
  const text = typeof chunk === "string" ? chunk : chunk.toString("latin1");
  // SGR: ESC [ < button ; col ; row (M=press | m=release)
  if (text.includes("<")) {
    const sgr = /<(\d+);(\d+);(\d+)([Mm])/g;
    let match: RegExpExecArray | null;
    while ((match = sgr.exec(text)) !== null) {
      dispatchMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "M", handlers);
    }
  }
  // Legacy X10: ESC [ M then 3 chars (button+32, col+32, row+32); press only.
  for (let i = 0; i + 6 <= text.length; i++) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[" && text[i + 2] === "M") {
      dispatchMouse(
        text.charCodeAt(i + 3) - 32,
        text.charCodeAt(i + 4) - 32,
        text.charCodeAt(i + 5) - 32,
        true,
        handlers,
      );
      i += 5;
    }
  }
}

/** Track the live terminal dimensions so the root box can fill the screen. */
function useTerminalSize(): { readonly columns: number; readonly rows: number } {
  const [size, setSize] = React.useState({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });
  React.useEffect(() => {
    const onResize = () =>
      setSize({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

// ── Row model ────────────────────────────────────────────────────────────────
//
// The list is a flat sequence of rows: one header per project followed by its
// threads, but only when the project is expanded. Projects are collapsed by
// default, so the cursor walks project headers until the user expands one.

type Selection =
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "more"; readonly id: string };

type Row =
  | {
      readonly kind: "project";
      readonly id: string;
      readonly title: string;
      readonly count: number;
      readonly status: ThreadStatus | null;
      readonly expanded: boolean;
    }
  | { readonly kind: "thread"; readonly id: string; readonly thread: OrchestrationThreadShell }
  | { readonly kind: "more"; readonly id: string; readonly hiddenCount: number };

function selectionEquals(selection: Selection | null, row: Row): boolean {
  return selection !== null && selection.kind === row.kind && selection.id === row.id;
}

/**
 * Only the top {@link DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT} threads of a project
 * render until its list is loaded in full — mirroring the web sidebar's
 * `getVisibleThreadsForProject`. The currently selected thread is always kept
 * visible so the cursor never points at a hidden row.
 */
function visibleThreadsForProject(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  loadedInFull: boolean,
  selectedThreadId: string | null,
): { readonly visible: OrchestrationThreadShell[]; readonly hidden: number } {
  const limit = DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT;
  if (loadedInFull || threads.length <= limit) {
    return { visible: [...threads], hidden: 0 };
  }
  const preview = threads.slice(0, limit);
  const selectedHidden =
    selectedThreadId !== null &&
    !preview.some((thread) => thread.id === selectedThreadId) &&
    threads.some((thread) => thread.id === selectedThreadId);
  if (!selectedHidden) {
    return { visible: preview, hidden: threads.length - limit };
  }
  const selected = threads.find((thread) => thread.id === selectedThreadId);
  return {
    visible: selected ? [...preview, selected] : preview,
    hidden: threads.length - limit - (selected ? 1 : 0),
  };
}

/** Pure: build the visible rows from the snapshot + UI state. */
export function buildRows(
  shell: OrchestrationShellSnapshot | null,
  expanded: ReadonlySet<string>,
  loadedInFull: ReadonlySet<string>,
  selectedThreadId: string | null,
): Row[] {
  if (!shell) return [];
  const projectTitles = new Map<string, string>(
    shell.projects.map((project) => [project.id, project.title]),
  );
  const byProject = new Map<string, OrchestrationThreadShell[]>();
  for (const thread of shell.threads) {
    const list = byProject.get(thread.projectId);
    if (list) list.push(thread);
    else byProject.set(thread.projectId, [thread]);
  }

  // Known projects first (in catalogue order), then any orphaned project ids.
  const orderedIds: string[] = [
    ...shell.projects.map((project) => project.id as string).filter((id) => byProject.has(id)),
    ...[...byProject.keys()].filter((id) => !projectTitles.has(id)),
  ];

  const rows: Row[] = [];
  for (const id of orderedIds) {
    const threads = byProject.get(id) ?? [];
    const isExpanded = expanded.has(id);
    rows.push({
      kind: "project",
      id,
      title: projectTitles.get(id) ?? id,
      count: threads.length,
      status: resolveProjectStatus(threads),
      expanded: isExpanded,
    });
    if (isExpanded) {
      const { visible, hidden } = visibleThreadsForProject(
        threads,
        loadedInFull.has(id),
        selectedThreadId,
      );
      for (const thread of visible) {
        rows.push({ kind: "thread", id: thread.id, thread });
      }
      if (hidden > 0) {
        rows.push({ kind: "more", id, hiddenCount: hidden });
      }
    }
  }
  return rows;
}

// ── External store ─────────────────────────────────────────────────────────
//
// Source of truth lives here, not in React, so it survives the Ink unmount /
// remount we do when entering the full-screen terminal passthrough.

interface StoreState {
  readonly shell: OrchestrationShellSnapshot | null;
  readonly expanded: ReadonlySet<string>;
  /** Projects whose full thread list has been loaded ("show more" activated). */
  readonly loadedInFull: ReadonlySet<string>;
  readonly selection: Selection | null;
  readonly detail: OrchestrationThread | null;
  readonly status: string;
}

interface Store {
  readonly getState: () => StoreState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly select: (selection: Selection) => void;
  readonly toggleProject: (id: string) => void;
  readonly loadMore: (id: string) => void;
  readonly setStatus: (status: string) => void;
}

function createStore(client: TuiClient): Store {
  let state: StoreState = {
    shell: null,
    expanded: new Set<string>(),
    loadedInFull: new Set<string>(),
    selection: null,
    detail: null,
    status: "Connecting…",
  };
  const listeners = new Set<() => void>();
  let unsubShell: (() => void) | null = null;
  let unsubThread: (() => void) | null = null;

  const selectedThreadId = () => (state.selection?.kind === "thread" ? state.selection.id : null);
  const rowsNow = () =>
    buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId());

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const subscribeDetail = (threadId: string | null) => {
    unsubThread?.();
    unsubThread = null;
    if (!threadId) return;
    unsubThread = client.subscribeThread(threadId as never, (thread) => {
      if (state.selection?.kind === "thread" && state.selection.id === thread.id) {
        set({ detail: thread });
      }
    });
  };

  const selectionFromRow = (row: Row): Selection =>
    row.kind === "thread" ? { kind: "thread", id: row.id } : { kind: row.kind, id: row.id };

  const applySelection = (selection: Selection | null) => {
    subscribeDetail(selection?.kind === "thread" ? selection.id : null);
    set({ selection, detail: null });
  };

  const ensureValidSelection = (rows: Row[]) => {
    if (rows.length === 0) {
      applySelection(null);
      return;
    }
    if (state.selection && rows.some((row) => selectionEquals(state.selection, row))) {
      return;
    }
    const fallback = rows.find((row) => row.kind === "thread") ?? rows[0];
    applySelection(fallback ? selectionFromRow(fallback) : null);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      unsubShell = client.subscribeShell((shell) => {
        const sortedThreads = shell.threads.toSorted((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        const nextShell = { ...shell, threads: sortedThreads };
        // Every project starts collapsed; the cursor lands on the first project
        // header until the user expands one.
        state = {
          ...state,
          shell: nextShell,
          status: `${nextShell.projects.length} project(s) · ${sortedThreads.length} thread(s)`,
        };
        ensureValidSelection(rowsNow());
        emit();
      });
    },
    stop: () => {
      unsubShell?.();
      unsubThread?.();
    },
    moveSelection: (delta) => {
      const rows = rowsNow();
      if (rows.length === 0) return;
      let index = rows.findIndex((row) => selectionEquals(state.selection, row));
      if (index < 0) index = 0;
      const nextIndex = Math.min(rows.length - 1, Math.max(0, index + delta));
      const next = rows[nextIndex];
      if (next) applySelection(selectionFromRow(next));
    },
    select: (selection) => applySelection(selection),
    toggleProject: (id) => {
      const expanded = new Set(state.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      set({ expanded });
      applySelection({ kind: "project", id });
    },
    loadMore: (id) => {
      const loadedInFull = new Set(state.loadedInFull).add(id);
      set({ loadedInFull });
      // Land the cursor on the first newly revealed thread (where "show more"
      // sat), so the user keeps reading downward.
      const projectThreads = (state.shell?.threads ?? []).filter(
        (thread) => thread.projectId === id,
      );
      const firstRevealed = projectThreads[DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT];
      applySelection(
        firstRevealed ? { kind: "thread", id: firstRevealed.id } : { kind: "project", id },
      );
    },
    setStatus: (status) => set({ status }),
  };
}

// ── Signals from the UI back to the top-level controller ────────────────────

type AppSignal = { readonly type: "exit" };

// ── Components ───────────────────────────────────────────────────────────────

/** Truncate to `width` with a trailing ellipsis (Ink's flex truncate is brittle). */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}
/** Truncate then right-pad so a fixed trailing segment sits at the right edge. */
function padClip(text: string, width: number): string {
  return clip(text, width).padEnd(Math.max(0, width));
}

const ProjectRow = React.memo(function ProjectRow({
  row,
  selected,
  innerWidth,
}: {
  readonly row: Extract<Row, { kind: "project" }>;
  readonly selected: boolean;
  readonly innerWidth: number;
}): React.ReactElement {
  const caret = row.expanded ? "▾" : "▸";
  const color = selected ? "cyan" : "blue";
  const count = ` (${row.count})`;
  const dot = row.status ? ` ${row.status.glyph}` : "";
  const titleBudget = innerWidth - 3 - count.length - dot.length; // lead "M C " = 3
  return h(
    Text,
    { color, bold: true, wrap: "truncate-end" },
    `${selected ? "›" : " "}${caret} `,
    padClip(row.title, titleBudget),
    count,
    row.status ? h(Text, { color: row.status.color, bold: row.status.bold }, dot) : null,
  );
});

const ThreadRow = React.memo(function ThreadRow({
  thread,
  selected,
  innerWidth,
}: {
  readonly thread: OrchestrationThreadShell;
  readonly selected: boolean;
  readonly innerWidth: number;
}): React.ReactElement {
  const status = resolveThreadStatus(thread);
  const time = ` ${relativeTime(thread.updatedAt)}`;
  const titleBudget = innerWidth - 6 - time.length; // lead "   ▶● " = 6
  return h(
    Text,
    { wrap: "truncate-end" },
    h(Text, { color: status.color, bold: status.bold }, `   ${selected ? "▶" : " "}${status.glyph} `),
    h(Text, { ...(selected ? { color: "cyan" as const } : {}), bold: selected }, padClip(thread.title, titleBudget)),
    h(Text, { dimColor: true }, time),
  );
});

const MoreRow = React.memo(function MoreRow({
  hiddenCount,
  selected,
}: {
  readonly hiddenCount: number;
  readonly selected: boolean;
}): React.ReactElement {
  return h(
    Text,
    { color: selected ? "cyan" : "gray", dimColor: !selected, bold: selected, wrap: "truncate-end" },
    `   ${selected ? "▶" : " "}… show ${hiddenCount} more`,
  );
});

function ThreadList({
  rows,
  selection,
  moreAbove,
  moreBelow,
  width,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly selection: Selection | null;
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  readonly width: number;
}): React.ReactElement {
  const innerWidth = Math.max(8, width - 4); // round border (2) + paddingX (2)
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
      overflow: "hidden",
    },
    h(
      Text,
      { bold: true, color: "cyan" },
      "Projects",
      moreAbove ? h(Text, { dimColor: true }, "  ↑ more") : null,
    ),
    ...(rows.length === 0
      ? [h(Text, { dimColor: true, key: "empty" }, "No projects yet. Press ^N.")]
      : rows.map((row) => {
          if (row.kind === "project") {
            return h(ProjectRow, {
              key: `p:${row.id}`,
              row,
              selected: selectionEquals(selection, row),
              innerWidth,
            });
          }
          if (row.kind === "more") {
            return h(MoreRow, {
              key: `m:${row.id}`,
              hiddenCount: row.hiddenCount,
              selected: selectionEquals(selection, row),
            });
          }
          return h(ThreadRow, {
            key: `t:${row.id}`,
            thread: row.thread,
            selected: selectionEquals(selection, row),
            innerWidth,
          });
        })),
    moreBelow ? h(Text, { dimColor: true }, "  ↓ more") : null,
  );
}

function statusLabel(thread: { session: OrchestrationThread["session"] }): string {
  return thread.session?.status ?? "idle";
}

interface ChatLine {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
}

/** Greedy word-wrap a paragraph (honouring existing newlines) to `width`. */
function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (word.length > max) {
        if (line.length > 0) {
          out.push(line);
          line = "";
        }
        let rest = word;
        while (rest.length > max) {
          out.push(rest.slice(0, max));
          rest = rest.slice(max);
        }
        line = rest;
        continue;
      }
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= max) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Per-message cache of wrapped body lines, keyed by the message object (which
 * the reducer keeps stable for unchanged messages) so a streaming update only
 * re-wraps the one message that changed — not the whole thread.
 */
const wrapCache = new WeakMap<OrchestrationMessage, { width: number; lines: string[] }>();
function wrapMessageBody(message: OrchestrationMessage, width: number): string[] {
  const cached = wrapCache.get(message);
  if (cached && cached.width === width) return cached.lines;
  const body = message.text.trim().length > 0 ? message.text.trim() : "…";
  const lines = wrapText(body, width);
  wrapCache.set(message, { width, lines });
  return lines;
}

/**
 * Flatten a thread's messages into individually styled display lines, wrapped
 * to the pane width. Line-accurate so the conversation paginates exactly to the
 * viewport — no message-sized clipping.
 */
function buildConversationLines(detail: OrchestrationThread, width: number): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const message of detail.messages) {
    const color =
      message.role === "user" ? "yellow" : message.role === "assistant" ? "white" : "gray";
    const who = message.role === "user" ? "you" : message.role;
    lines.push({ text: `${who}${message.streaming ? " ⟳" : ""}`, color, bold: true });
    for (const wrapped of wrapMessageBody(message, width)) lines.push({ text: wrapped, color });
    lines.push({ text: "" });
  }
  return lines;
}

/**
 * A vertical scrollbar column: an array of `height` glyphs with a proportional
 * thumb marking the current window position. Empty when everything fits.
 */
function scrollbarColumn(total: number, height: number, start: number): string[] {
  if (total <= height) return [];
  const thumb = Math.max(1, Math.round((height * height) / total));
  const maxStart = total - height;
  const thumbStart =
    maxStart <= 0 ? 0 : Math.round((height - thumb) * (Math.min(start, maxStart) / maxStart));
  return Array.from({ length: height }, (_, index) =>
    index >= thumbStart && index < thumbStart + thumb ? "█" : "│",
  );
}

function ThreadDetail({
  detail,
  approvals,
  projectHint,
  lines,
  bodyHeight,
  start,
}: {
  readonly detail: OrchestrationThread | null;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly projectHint: string | null;
  readonly lines: ReadonlyArray<ChatLine>;
  readonly bodyHeight: number;
  readonly start: number;
}): React.ReactElement {
  if (!detail) {
    return h(
      Box,
      { flexGrow: 1, borderStyle: "round", borderColor: "gray", paddingX: 1 },
      h(
        Text,
        { dimColor: true },
        projectHint
          ? `${projectHint} — Enter to expand, then ↑/↓ to pick a thread.`
          : "Select a thread to view its conversation.",
      ),
    );
  }
  // `start` is the absolute index of the top visible line (computed by the
  // parent so streaming appends don't drag the viewport).
  const total = lines.length;
  const visible = lines.slice(start, start + bodyHeight);
  const bar = scrollbarColumn(total, bodyHeight, start);
  return h(
    Box,
    {
      flexDirection: "column",
      flexGrow: 1,
      borderStyle: "round",
      borderColor: "gray",
      paddingX: 1,
      overflow: "hidden",
    },
    h(
      Box,
      { flexDirection: "row", width: "100%" },
      h(
        Box,
        { flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden" },
        h(Text, { bold: true, wrap: "truncate-end" }, detail.title),
      ),
      h(
        Text,
        null,
        h(Text, { dimColor: true }, "  "),
        h(
          Text,
          { color: approvals.length > 0 ? "red" : sessionStatusColor(detail.session?.status) },
          approvals.length > 0 ? "pending approval" : statusLabel(detail),
        ),
        h(Text, { dimColor: true }, `  ·  ${detail.runtimeMode}  ·  ${relativeTime(detail.updatedAt)}`),
      ),
    ),
    h(
      Box,
      { flexDirection: "row", flexGrow: 1, overflow: "hidden" },
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
        ...visible.map((line, index) =>
          h(
            Text,
            {
              key: start + index,
              wrap: "truncate-end",
              ...(line.color ? { color: line.color } : {}),
              ...(line.bold ? { bold: true } : {}),
            },
            line.text.length > 0 ? line.text : " ",
          ),
        ),
      ),
      bar.length > 0
        ? h(
            Box,
            { flexDirection: "column", marginLeft: 1 },
            ...bar.map((glyph, index) =>
              h(
                Text,
                { key: index, color: glyph === "█" ? "cyan" : "gray", dimColor: glyph !== "█" },
                glyph,
              ),
            ),
          )
        : null,
    ),
    ...(approvals.length > 0
      ? [
          h(
            Box,
            {
              key: "approvals",
              flexDirection: "column",
              borderStyle: "round",
              borderColor: "red",
              paddingX: 1,
            },
            h(Text, { color: "red", bold: true }, "Approval required"),
            ...approvals.map((approval) =>
              h(
                Text,
                { key: approval.requestId },
                `${approval.requestKind}${approval.detail ? `: ${approval.detail}` : ""}`,
              ),
            ),
            h(Text, { dimColor: true }, "^A approve   ^R deny"),
          ),
        ]
      : []),
  );
}

interface TerminalInfo {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly title: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/** Ink props for one styled terminal segment (no `undefined` values). */
function segmentProps(segment: TermSegment): Record<string, unknown> {
  return {
    ...(segment.color ? { color: segment.color } : {}),
    ...(segment.backgroundColor ? { backgroundColor: segment.backgroundColor } : {}),
    ...(segment.bold ? { bold: true } : {}),
    ...(segment.dimColor ? { dimColor: true } : {}),
    ...(segment.italic ? { italic: true } : {}),
    ...(segment.underline ? { underline: true } : {}),
    ...(segment.inverse ? { inverse: true } : {}),
  };
}

/**
 * Embedded terminal pane: owns a headless xterm emulator (the same engine as the
 * web UI), feeds it the thread's PTY output, and renders its grid into Ink —
 * matching the web instead of taking over the screen.
 */
function TerminalPane({
  client,
  info,
  cols,
  rows,
}: {
  readonly client: TuiClient;
  readonly info: TerminalInfo;
  readonly cols: number;
  readonly rows: number;
}): React.ReactElement {
  const safeCols = Math.max(2, cols);
  const safeRows = Math.max(2, rows);
  const termRef = React.useRef<XTerm | null>(null);
  const scheduled = React.useRef(false);
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
      termRef.current?.dispose();
      termRef.current = null;
    },
    [],
  );

  // Keep the emulator and the PTY sized to the pane.
  React.useEffect(() => {
    if (term.cols !== safeCols || term.rows !== safeRows) term.resize(safeCols, safeRows);
    void client.terminalResize(info.threadId, info.terminalId, safeCols, safeRows).catch(() => {});
  }, [safeCols, safeRows]);

  // Attach to the thread terminal and stream its output into the emulator.
  React.useEffect(() => {
    const scheduleRender = () => {
      if (scheduled.current) return;
      scheduled.current = true;
      setTimeout(() => {
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
          // Threads can accumulate megabytes of history; only replay the tail so
          // attaching stays instant.
          const history = event.snapshot.history;
          term.write(history.length > TERMINAL_HISTORY_TAIL
            ? history.slice(history.length - TERMINAL_HISTORY_TAIL)
            : history, scheduleRender);
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
  return h(
    Box,
    {
      flexDirection: "column",
      height: safeRows + 3, // title (1) + grid + round border (2)
      flexShrink: 0,
      borderStyle: "round",
      borderColor: "yellow",
      paddingX: 1,
      overflow: "hidden",
    },
    h(
      Text,
      { bold: true, color: "yellow", wrap: "truncate-end" },
      `Terminal · ${info.title}`,
      h(Text, { dimColor: true }, "  ·  drag top edge to resize · Ctrl+Q to return"),
    ),
    ...frame.rows.map((segments, index) =>
      h(
        Text,
        { key: index, wrap: "truncate-end" },
        segments.length === 0
          ? " "
          : segments.map((segment, segmentIndex) =>
              h(Text, { key: segmentIndex, ...segmentProps(segment) }, segment.text),
            ),
      ),
    ),
  );
}

function App({
  store,
  client,
  emit,
}: {
  readonly store: Store;
  readonly client: TuiClient;
  readonly emit: (signal: AppSignal) => void;
}): React.ReactElement {
  const state = React.useSyncExternalStore(store.subscribe, store.getState);
  const size = useTerminalSize();
  const [focus, setFocus] = React.useState<"compose" | "new">("compose");
  const [reply, setReply] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [projectIndex, setProjectIndex] = React.useState(0);
  // Absolute index of the top visible conversation line, or `null` to follow the
  // latest message (stick to bottom). Absolute so streaming appends don't move it.
  const [chatTop, setChatTop] = React.useState<number | null>(null);
  // When set, a bottom drawer shows the embedded terminal and keystrokes go to it.
  const [activeTerminal, setActiveTerminal] = React.useState<TerminalInfo | null>(null);
  // User-dragged drawer height (rows); null = default proportion of the screen.
  const [terminalHeight, setTerminalHeight] = React.useState<number | null>(null);
  // Width of the thread-list pane (drag-resizable).
  const [listWidth, setListWidth] = React.useState(LIST_PANE_WIDTH);
  const activeTerminalRef = React.useRef<TerminalInfo | null>(null);
  activeTerminalRef.current = activeTerminal;
  const closeTerminalRef = React.useRef<() => void>(() => {});
  closeTerminalRef.current = () => setActiveTerminal(null);
  // Which divider (if any) is being dragged: the vertical list edge or the
  // horizontal terminal-drawer top edge.
  const dividerDragRef = React.useRef<"list" | "terminal" | null>(null);

  const projects = state.shell?.projects ?? [];
  const selectedThreadId = state.selection?.kind === "thread" ? state.selection.id : null;
  const rows = React.useMemo(
    () => buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId),
    [state.shell, state.expanded, state.loadedInFull, selectedThreadId],
  );
  const detail = state.detail;
  const approvals = React.useMemo(
    () => (detail ? derivePendingApprovals(detail.activities) : []),
    [detail],
  );
  const selectedProjectTitle =
    state.selection?.kind === "project"
      ? (projects.find((project) => project.id === state.selection?.id)?.title ?? null)
      : null;

  // Follow the latest message again when switching threads.
  React.useEffect(() => {
    setChatTop(null);
  }, [selectedThreadId]);

  // The terminal is a full-width bottom drawer (like the web) whose height the
  // user can drag. The list + conversation stay visible above it.
  const terminalDrawerHeight = activeTerminal
    ? Math.min(
        Math.max(terminalHeight ?? Math.floor(size.rows * 0.62), 6),
        Math.max(6, size.rows - 6),
      )
    : 0;

  // Deterministic viewport heights derived from the terminal size + the fixed
  // composer/footer (or drawer) rows, so the list follows the cursor and scroll.
  const composerHeight = focus === "new" ? 6 : 5;
  const bottomReserve = activeTerminal ? terminalDrawerHeight + 1 : composerHeight + 1;
  const panesHeight = Math.max(4, size.rows - bottomReserve);
  const listViewport = Math.max(1, panesHeight - 3); // round border (2) + header (1)
  // Drawer interior: full width minus border (2) + padding (2); height minus
  // border (2) + title (1).
  const termCols = Math.max(2, size.columns - 4);
  const termRows = Math.max(2, terminalDrawerHeight - 3);
  // Terminal drawer's top border row (drag handle), 1-based.
  const dividerRow = panesHeight + 1;

  // Window the list around the selection so the highlighted row stays on screen.
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => selectionEquals(state.selection, row)),
  );
  const listStart =
    rows.length <= listViewport
      ? 0
      : Math.min(
          Math.max(0, selectedIndex - Math.floor(listViewport / 2)),
          rows.length - listViewport,
        );
  const listRows = rows.slice(listStart, listStart + listViewport);
  const moreAbove = listStart > 0;
  const moreBelow = listStart + listViewport < rows.length;

  // Line-accurate conversation pagination: wrap every message to the pane width,
  // then scroll through the flat line list a precise window at a time.
  const chatWidth = Math.max(20, size.columns - listWidth - 6);
  const conversationLines = React.useMemo(
    () => (detail ? buildConversationLines(detail, chatWidth) : []),
    [detail, chatWidth],
  );
  const approvalRows = approvals.length > 0 ? approvals.length + 3 : 0;
  // border (2) + title (1) + any approval panel.
  const chatBodyHeight = Math.max(1, panesHeight - 3 - approvalRows);
  const maxStart = Math.max(0, conversationLines.length - chatBodyHeight);
  // Resolve the anchor: null follows the bottom; otherwise clamp the saved top.
  const chatStart = chatTop === null ? maxStart : Math.min(Math.max(0, chatTop), maxStart);

  // Positive delta scrolls up (older); reaching the bottom re-enables following.
  const scrollChat = (deltaLines: number) => {
    setChatTop((previous) => {
      const base = previous === null ? maxStart : Math.min(Math.max(0, previous), maxStart);
      const next = base - deltaLines;
      return next >= maxStart ? null : Math.max(0, next);
    });
  };

  // Mouse handlers are kept in refs so the stdin listener (registered once)
  // always calls the latest closures.
  const onWheelRef = React.useRef<(direction: "up" | "down", column: number) => void>(() => {});
  onWheelRef.current = (direction, column) => {
    if (focus === "new") return;
    const inList = column <= listWidth + 1;
    if (inList) {
      // Move the list selection a few rows per notch.
      store.moveSelection(direction === "up" ? -2 : 2);
    } else {
      scrollChat(direction === "up" ? WHEEL_LINES : -WHEEL_LINES);
    }
  };
  // Click a list row: thread → select/open, project → expand/collapse, more →
  // load more. The list box is: row 1 border, row 2 "Projects", rows 3.. items.
  const onClickRef = React.useRef<(column: number, row: number) => void>(() => {});
  onClickRef.current = (column, row) => {
    if (focus !== "compose") return;
    if (column > listWidth) return;
    const index = row - 3;
    const target = listRows[index];
    if (!target) return;
    if (target.kind === "project") store.toggleProject(target.id);
    else if (target.kind === "more") store.loadMore(target.id);
    else store.select({ kind: "thread", id: target.id });
  };
  // Drag a divider: the vertical list/conversation edge (by column) or the
  // terminal drawer's top edge (by row). Returns whether the event belonged to a
  // divider (so terminal mode knows not to forward it to the PTY).
  const dividerPressRef = React.useRef<(column: number, row: number) => boolean>(() => false);
  dividerPressRef.current = (column, row) => {
    if (Math.abs(column - listWidth) <= 1) {
      dividerDragRef.current = "list";
      return true;
    }
    if (activeTerminal && Math.abs(row - dividerRow) <= 1) {
      dividerDragRef.current = "terminal";
      return true;
    }
    return false;
  };
  const dividerMoveRef = React.useRef<(column: number, row: number) => boolean>(() => false);
  dividerMoveRef.current = (column, row) => {
    if (dividerDragRef.current === "list") {
      setListWidth(Math.min(Math.max(column, 22), Math.max(22, size.columns - 24)));
      return true;
    }
    if (dividerDragRef.current === "terminal") {
      setTerminalHeight(Math.min(Math.max(size.rows - row, 6), Math.max(6, size.rows - 6)));
      return true;
    }
    return false;
  };
  const dividerReleaseRef = React.useRef<() => boolean>(() => false);
  dividerReleaseRef.current = () => {
    if (dividerDragRef.current === null) return false;
    dividerDragRef.current = null;
    return true;
  };
  React.useEffect(() => {
    // Enable mouse *after* Ink has initialised the terminal so it can't clobber
    // the mode we set, then parse wheel + click/drag events from the raw stream.
    enableMouse();
    const onData = (chunk: Buffer | string) => {
      logInputBytes(chunk);
      const term = activeTerminalRef.current;
      if (term) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (text.length === 1 && text.charCodeAt(0) === TERMINAL_DETACH_BYTE) {
          closeTerminalRef.current();
          return;
        }
        // Resizing a divider takes priority; everything else goes to the PTY.
        let handled = false;
        parseMouse(chunk, {
          onWheel: () => {},
          onPress: (column, row) => {
            if (dividerPressRef.current(column, row)) handled = true;
          },
          onDrag: (column, row) => {
            if (dividerMoveRef.current(column, row)) handled = true;
          },
          onRelease: () => {
            if (dividerReleaseRef.current()) handled = true;
          },
        });
        if (handled) return;
        void client.terminalWrite(term.threadId, term.terminalId, text).catch(() => {});
        return;
      }
      parseMouse(chunk, {
        onWheel: (direction, column) => onWheelRef.current(direction, column),
        onPress: (column, row) => {
          if (!dividerPressRef.current(column, row)) onClickRef.current(column, row);
        },
        onDrag: (column, row) => {
          dividerMoveRef.current(column, row);
        },
        onRelease: () => {
          dividerReleaseRef.current();
        },
      });
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
      disableMouse();
    };
  }, []);

  useInput((input, key) => {
    // While the embedded terminal is open, all keystrokes are forwarded to the
    // PTY by the stdin listener above — ignore them here.
    if (activeTerminal) return;
    // Swallow any leftover of an SGR mouse report so it never types into the
    // prompt — the wheel itself is handled by the stdin listener above.
    if (input && (input.includes("\x1b") || MOUSE_SEQUENCE.test(input))) {
      return;
    }
    // Ctrl-C always exits cleanly so we restore the screen instead of leaving
    // the terminal stuck in the alternate buffer.
    if (key.ctrl && input === "c") {
      emit({ type: "exit" });
      return;
    }

    // ── New-thread dialog ────────────────────────────────────────────────────
    if (focus === "new") {
      if (key.escape) {
        setDraft("");
        setFocus("compose");
        return;
      }
      if (key.upArrow) {
        setProjectIndex((index) => (index > 0 ? index - 1 : Math.max(projects.length - 1, 0)));
        return;
      }
      if (key.downArrow) {
        setProjectIndex((index) => (index + 1) % Math.max(projects.length, 1));
        return;
      }
      if (key.return) {
        const project = projects[projectIndex];
        const message = draft.trim();
        if (project && message.length > 0) {
          if (!project.defaultModelSelection) {
            store.setStatus("Project has no default model — set one in the web UI first.");
          } else {
            void client
              .createThread({
                projectId: project.id,
                title: message.slice(0, 60),
                modelSelection: project.defaultModelSelection,
                firstMessage: message,
              })
              .catch((error) => store.setStatus(`create failed: ${String(error)}`));
            store.setStatus("Creating thread…");
          }
        }
        setDraft("");
        setFocus("compose");
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((value) => value + input);
      }
      return;
    }

    // ── Compose mode (default): the prompt is always ready for typing ─────────

    // Thread navigation is on the arrow keys so plain typing flows to the prompt.
    if (key.upArrow) {
      store.moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      store.moveSelection(1);
      return;
    }

    // Conversation scrolling (in display lines): PgUp/PgDn = a page, ^U/^D = half.
    const page = Math.max(1, chatBodyHeight - 1);
    const halfPage = Math.max(1, Math.floor(chatBodyHeight / 2));
    if (key.pageUp) {
      scrollChat(page);
      return;
    }
    if (key.pageDown) {
      scrollChat(-page);
      return;
    }
    if (key.ctrl && input === "u") {
      scrollChat(halfPage);
      return;
    }
    if (key.ctrl && input === "d") {
      scrollChat(-halfPage);
      return;
    }

    // Ctrl-shortcuts for actions (bare letters are reserved for the prompt).
    if (key.ctrl && input === "n") {
      setProjectIndex(0);
      setFocus("new");
      return;
    }
    // Open the embedded thread terminal: Ctrl+E (reliable) or Alt+T (mnemonic).
    if (((key.ctrl && input === "e") || (key.meta && input === "t")) && detail) {
      const project = projects.find((p) => p.id === detail.projectId);
      const cwd = detail.worktreePath ?? project?.workspaceRoot ?? process.cwd();
      setActiveTerminal({
        threadId: detail.id,
        terminalId: DEFAULT_TERMINAL_ID,
        title: detail.title,
        cwd,
        worktreePath: detail.worktreePath,
      });
      return;
    }
    if (key.ctrl && input === "g" && detail) {
      void client.interrupt(detail.id).catch(() => {});
      store.setStatus("Interrupt sent.");
      return;
    }
    if (key.ctrl && input === "a" && detail && approvals[0]) {
      void client.approve(detail.id, approvals[0].requestId, "accept").catch(() => {});
      store.setStatus("Approved.");
      return;
    }
    if (key.ctrl && input === "r" && detail && approvals[0]) {
      void client.approve(detail.id, approvals[0].requestId, "decline").catch(() => {});
      store.setStatus("Declined.");
      return;
    }
    if (key.ctrl && input === "o" && detail) {
      const current = RUNTIME_MODES.indexOf(detail.runtimeMode);
      const nextMode = RUNTIME_MODES[(current + 1) % RUNTIME_MODES.length] ?? "full-access";
      void client.setRuntimeMode(detail.id, nextMode).catch(() => {});
      store.setStatus(`Mode → ${nextMode}`);
      return;
    }

    if (key.return) {
      const text = reply.trim();
      if (text.length > 0) {
        // Send the prompt to the selected thread.
        if (detail) {
          void client
            .sendReply(detail, text)
            .catch((error) => store.setStatus(`send failed: ${String(error)}`));
          store.setStatus("Reply sent.");
          setReply("");
        } else {
          store.setStatus("Select a thread (↑/↓) to send a message.");
        }
        return;
      }
      // Empty prompt → Enter activates the highlighted row.
      if (state.selection?.kind === "project") {
        store.toggleProject(state.selection.id);
      } else if (state.selection?.kind === "more") {
        store.loadMore(state.selection.id);
      }
      return;
    }

    if (key.escape) {
      if (reply.length > 0) {
        setReply("");
        return;
      }
      if (detail) {
        void client.interrupt(detail.id).catch(() => {});
        store.setStatus("Interrupt sent.");
      }
      return;
    }

    if (key.backspace || key.delete) {
      setReply((value) => value.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setReply((value) => value + input);
    }
  });

  // Once a thread is selected the field is "focused" and ready, so no
  // placeholder — just the cursor. Only hint when there is no thread to message.
  const placeholder = detail
    ? null
    : state.selection?.kind === "project"
      ? "Enter to expand · ↑/↓ to move · type to compose"
      : state.selection?.kind === "more"
        ? "Enter to load more · ↑/↓ to move"
        : "Select a thread with ↑/↓ to start typing";

  const hint =
    "↑/↓ threads · PgUp/PgDn scroll · Enter send · ^N new · ^E term · ^G stop · ^A/^R approve · ^O mode · ^C quit";

  const composer =
    focus === "new"
      ? h(
          Box,
          { flexDirection: "column" },
          h(
            Text,
            null,
            h(Text, { color: "cyan" }, "new thread ▸ project: "),
            projects[projectIndex]?.title ?? "(none)",
            h(Text, { dimColor: true }, "  ↑/↓ change · Esc cancel"),
          ),
          h(
            Text,
            null,
            h(Text, { color: "cyan" }, "message ▸ "),
            draft,
            h(Text, { inverse: true }, " "),
          ),
        )
      : h(
          Text,
          null,
          h(Text, { color: "yellow" }, "› "),
          reply.length > 0
            ? reply
            : placeholder
              ? h(Text, { dimColor: true }, placeholder)
              : null,
          h(Text, { inverse: true }, " "),
        );

  // Top area: thread list + conversation. Fills the screen normally; in terminal
  // mode it shrinks to the height above the drawer (conversation stays visible).
  const topArea = h(
    Box,
    activeTerminal
      ? { height: panesHeight, flexShrink: 0, overflow: "hidden" }
      : { flexGrow: 1, overflow: "hidden" },
    h(ThreadList, {
      rows: listRows,
      selection: state.selection,
      moreAbove,
      moreBelow,
      width: listWidth,
    }),
    h(ThreadDetail, {
      detail,
      approvals,
      projectHint: selectedProjectTitle,
      lines: conversationLines,
      bodyHeight: chatBodyHeight,
      start: chatStart,
    }),
  );

  if (activeTerminal) {
    return h(
      Box,
      { flexDirection: "column", width: size.columns, height: size.rows },
      topArea,
      h(TerminalPane, { client, info: activeTerminal, cols: termCols, rows: termRows }),
      h(
        Box,
        { paddingX: 1, flexShrink: 0 },
        h(
          Text,
          { wrap: "truncate-end", dimColor: true },
          "keys → shell · drag the drawer's top edge to resize · Ctrl+Q to return",
        ),
      ),
    );
  }

  return h(
    Box,
    { flexDirection: "column", width: size.columns, height: size.rows },
    topArea,
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: focus === "new" ? "cyan" : "yellow",
        paddingX: 1,
        flexShrink: 0,
        minHeight: focus === "new" ? 6 : 5,
      },
      composer,
    ),
    h(
      Box,
      { justifyContent: "space-between", paddingX: 1, flexShrink: 0 },
      h(Text, { dimColor: true, wrap: "truncate-end" }, hint),
      h(Text, { dimColor: true, wrap: "truncate-end" }, ` ${state.status}`),
    ),
  );
}

// ── Top-level controller ─────────────────────────────────────────────────────

function renderUntilExit(store: Store, client: TuiClient): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    // Render fullscreen in the alternate screen buffer so the UI owns the whole
    // terminal and never pollutes scrollback. Enable mouse reporting *before* the
    // first frame (so tmux/the terminal latches onto "this app wants the wheel"),
    // then the app re-asserts it after mount as well.
    enterFullscreen();
    enableMouse();
    const instance = render(
      h(App, {
        store,
        client,
        emit: (signal: AppSignal) => {
          if (settled || signal.type !== "exit") return;
          settled = true;
          // Let React finish this tick, then tear down Ink before resolving so
          // its stdin/raw-mode handlers are detached and the screen is restored.
          setImmediate(() => {
            instance.unmount();
            disableMouse();
            leaveFullscreen();
            resolve();
          });
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}

export async function runTuiApp(client: TuiClient): Promise<void> {
  const store = createStore(client);
  store.start();
  // Safety net: if the process dies unexpectedly, leave the alternate screen so
  // the user's terminal isn't left in a broken state.
  const restoreScreen = () => {
    try {
      disableMouse();
      leaveFullscreen();
    } catch {
      // best effort
    }
  };
  process.once("exit", restoreScreen);
  try {
    await renderUntilExit(store, client);
  } finally {
    store.stop();
  }
}
