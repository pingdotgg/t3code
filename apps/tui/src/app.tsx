import { createRequire } from "node:module";

import {
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  DEFAULT_TERMINAL_ID,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { RGBA, type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
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
import type { OrchestrationShellSnapshot, OrchestrationThread, TuiClient } from "./connection.ts";

// @xterm/headless ships as CommonJS, so load it via createRequire (matching the
// repo's node-pty pattern) rather than a named ESM import. Works under Bun.
const { Terminal } = createRequire(import.meta.url)(
  "@xterm/headless",
) as typeof import("@xterm/headless");
type XTerm = InstanceType<typeof Terminal>;

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

/** Default width of the thread-list pane. */
const LIST_PANE_WIDTH = 34;
/** Conversation lines scrolled per page key. */
const SCROLL_STEP = 8;
/** Replay at most this many bytes of terminal history on attach (keeps it fast). */
const TERMINAL_HISTORY_TAIL = 128 * 1024;

// ── Terminal-themed colours ──────────────────────────────────────────────────
//
// OpenTUI is a truecolor framebuffer renderer, but it can emit *indexed* and
// *default* colour intents that the terminal renders with ITS OWN palette. We use
// those exclusively so the UI borrows the user's theme (any dark/light scheme)
// instead of hardcoding hex that fights their background:
//   - `text`   → the terminal's default foreground (RGBA.defaultForeground)
//   - `bg`     → the terminal's default background (used for inverse cells)
//   - `dim`    → ANSI slot 8 ("bright black"), the theme's muted grey
//   - `accent` → ANSI slot 6 (cyan)
//   - status/role/border colours map their names to ANSI slots 0–15 via `ansi()`.
// The renderer itself is created with a transparent background, so the terminal's
// own backdrop shows through.

const ANSI_INDEX: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  grey: 8,
  brightblack: 8,
  brightred: 9,
  brightgreen: 10,
  brightyellow: 11,
  brightblue: 12,
  brightmagenta: 13,
  brightcyan: 14,
  brightwhite: 15,
};

/** Resolve a named colour to an indexed RGBA the terminal themes itself. */
function ansi(name: string): RGBA {
  const index = ANSI_INDEX[name.toLowerCase()];
  return index === undefined ? RGBA.defaultForeground() : RGBA.fromIndex(index);
}

interface Palette {
  readonly text: RGBA;
  readonly bg: RGBA;
  readonly dim: RGBA;
  readonly accent: RGBA;
  readonly selectedBg: RGBA;
}

const THEME: Palette = {
  text: RGBA.defaultForeground(),
  bg: RGBA.defaultBackground(),
  dim: RGBA.fromIndex(8),
  accent: RGBA.fromIndex(6),
  selectedBg: RGBA.fromIndex(8),
};

const usePalette = (): Palette => THEME;

// ── Row model ────────────────────────────────────────────────────────────────

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

/** Truncate to `width` with a trailing ellipsis. */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}
/** Truncate then right-pad so a fixed trailing segment sits at the right edge. */
function padClip(text: string, width: number): string {
  return clip(text, width).padEnd(Math.max(0, width));
}

/**
 * Only the top {@link DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT} threads of a project
 * render until its list is loaded in full — mirroring the web sidebar. The
 * currently selected thread is always kept visible.
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

interface StoreState {
  readonly shell: OrchestrationShellSnapshot | null;
  readonly expanded: ReadonlySet<string>;
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

// ── List rows ────────────────────────────────────────────────────────────────

function ProjectRow({
  row,
  selected,
  innerWidth,
  onClick,
}: {
  readonly row: Extract<Row, { kind: "project" }>;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly onClick: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const caret = row.expanded ? "▾" : "▸";
  const count = ` (${row.count})`;
  const dot = row.status ? ` ${row.status.glyph}` : "";
  const titleBudget = innerWidth - 3 - count.length - dot.length;
  return (
    <box onMouseDown={onClick} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text>
        <span fg={selected ? palette.accent : palette.text}>
          {`${selected ? "▌" : " "}${caret} ${padClip(row.title, titleBudget)}${count}`}
        </span>
        {row.status ? <span fg={ansi(row.status.color)}>{dot}</span> : null}
      </text>
    </box>
  );
}

function ThreadRow({
  thread,
  selected,
  innerWidth,
  onClick,
}: {
  readonly thread: OrchestrationThreadShell;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly onClick: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const status = resolveThreadStatus(thread);
  const time = ` ${relativeTime(thread.updatedAt)}`;
  const titleBudget = innerWidth - 4 - time.length;
  return (
    <box onMouseDown={onClick} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text>
        <span fg={palette.accent}>{selected ? "▌ " : "  "}</span>
        <span fg={ansi(status.color)}>{`${status.glyph} `}</span>
        <span fg={palette.text}>{padClip(thread.title, titleBudget)}</span>
        <span fg={palette.dim}>{time}</span>
      </text>
    </box>
  );
}

function MoreRow({
  hiddenCount,
  selected,
  onClick,
}: {
  readonly hiddenCount: number;
  readonly selected: boolean;
  readonly onClick: () => void;
}): React.ReactNode {
  const palette = usePalette();
  return (
    <box onMouseDown={onClick} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text fg={selected ? palette.accent : palette.dim}>
        {`   ${selected ? "▶" : " "}… show ${hiddenCount} more`}
      </text>
    </box>
  );
}

function ThreadList({
  rows,
  selection,
  moreAbove,
  moreBelow,
  width,
  height,
  store,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly selection: Selection | null;
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  readonly width: number;
  readonly height: number;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  const innerWidth = Math.max(8, width - 4);
  const activate = (row: Row) => {
    if (row.kind === "project") store.toggleProject(row.id);
    else if (row.kind === "more") store.loadMore(row.id);
    else store.select({ kind: "thread", id: row.id });
  };
  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={palette.accent}>Projects</span>
        {moreAbove ? <span fg={palette.dim}>{"  ↑ more"}</span> : null}
      </text>
      {rows.length === 0 ? (
        <text fg={palette.dim}>No projects yet. Press ^N.</text>
      ) : (
        rows.map((row) => {
          const selected = selectionEquals(selection, row);
          if (row.kind === "project") {
            return (
              <ProjectRow
                key={`p:${row.id}`}
                row={row}
                selected={selected}
                innerWidth={innerWidth}
                onClick={() => activate(row)}
              />
            );
          }
          if (row.kind === "more") {
            return (
              <MoreRow
                key={`m:${row.id}`}
                hiddenCount={row.hiddenCount}
                selected={selected}
                onClick={() => activate(row)}
              />
            );
          }
          return (
            <ThreadRow
              key={`t:${row.id}`}
              thread={row.thread}
              selected={selected}
              innerWidth={innerWidth}
              onClick={() => activate(row)}
            />
          );
        })
      )}
      {moreBelow ? <text fg={palette.dim}>{"  ↓ more"}</text> : null}
    </box>
  );
}

function statusLabel(thread: { session: OrchestrationThread["session"] }): string {
  return thread.session?.status ?? "idle";
}

// ── Conversation (scrollbox + streaming markdown) ────────────────────────────

function ConversationView({
  detail,
  approvals,
  projectHint,
  width,
  height,
  syntaxStyle,
  scrollRef,
}: {
  readonly detail: OrchestrationThread | null;
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly projectHint: string | null;
  readonly width: number;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const palette = usePalette();
  const headerHeight = 1;
  const approvalHeight = approvals.length > 0 ? approvals.length + 2 : 0;
  const bodyHeight = Math.max(1, height - headerHeight - approvalHeight - 2);

  if (!detail) {
    return (
      <box
        flexGrow={1}
        height={height}
        border
        borderStyle="rounded"
        borderColor={palette.dim}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={palette.dim}>
          {projectHint
            ? `${projectHint} — Enter to expand, then ↑/↓ to pick a thread.`
            : "Select a thread to view its conversation."}
        </text>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" width="100%">
        <box flexGrow={1}>
          <text fg={palette.text}>
            <strong>{clip(detail.title, Math.max(8, width - 28))}</strong>
          </text>
        </box>
        <text>
          <span fg={approvals.length > 0 ? ansi("red") : ansi(sessionStatusColor(detail.session?.status))}>
            {approvals.length > 0 ? "pending approval" : statusLabel(detail)}
          </span>
          <span fg={palette.dim}>{`  ·  ${detail.runtimeMode}  ·  ${relativeTime(detail.updatedAt)}`}</span>
        </text>
      </box>

      <scrollbox
        ref={scrollRef}
        height={bodyHeight}
        stickyScroll
        stickyStart="bottom"
        style={{ rootOptions: { backgroundColor: "transparent" } }}
      >
        {detail.messages.map((message) => {
          const roleColor =
            message.role === "user"
              ? ansi("yellow")
              : message.role === "assistant"
                ? palette.accent
                : palette.dim;
          const who = message.role === "user" ? "you" : message.role;
          const body = message.text.trim().length > 0 ? message.text : "…";
          return (
            <box key={message.id} flexDirection="column" marginBottom={1}>
              <text>
                <span fg={roleColor}>{who}</span>
                {message.streaming ? <span fg={palette.dim}> ⟳</span> : null}
              </text>
              <markdown content={body} syntaxStyle={syntaxStyle} streaming={message.streaming} />
            </box>
          );
        })}
      </scrollbox>

      {approvals.length > 0 ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={ansi("red")} paddingLeft={1} paddingRight={1}>
          <text>
            <span fg={ansi("red")}>Approval required</span>
          </text>
          {approvals.map((approval) => (
            <text key={approval.requestId}>
              {`${approval.requestKind}${approval.detail ? `: ${approval.detail}` : ""}`}
            </text>
          ))}
          <text fg={palette.dim}>^A approve   ^R deny</text>
        </box>
      ) : null}
    </box>
  );
}

// ── Embedded terminal pane ───────────────────────────────────────────────────

interface TerminalInfo {
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
}): React.ReactNode {
  const palette = usePalette();
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

  React.useEffect(() => {
    if (term.cols !== safeCols || term.rows !== safeRows) term.resize(safeCols, safeRows);
    void client.terminalResize(info.threadId, info.terminalId, safeCols, safeRows).catch(() => {});
  }, [safeCols, safeRows]);

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
      height={safeRows + 3}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={ansi("yellow")}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={ansi("yellow")}>{`Terminal · ${info.title}`}</span>
        <span fg={palette.dim}>{"  ·  Ctrl+Q to return"}</span>
      </text>
      {frame.rows.map((segments, index) => (
        <text key={index}>
          {segments.length === 0 ? " " : segments.map((segment, i) => renderSegment(segment, i))}
        </text>
      ))}
    </box>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export function App({
  client,
  onExit,
}: {
  readonly client: TuiClient;
  readonly onExit: () => void;
}): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const palette = usePalette();
  const store = React.useMemo(() => createStore(client), [client]);
  const syntaxStyle = React.useMemo(() => SyntaxStyle.create(), []);
  const state = React.useSyncExternalStore(store.subscribe, store.getState);

  React.useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const [focus, setFocus] = React.useState<"compose" | "new">("compose");
  const [reply, setReply] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [projectIndex, setProjectIndex] = React.useState(0);
  const [activeTerminal, setActiveTerminal] = React.useState<TerminalInfo | null>(null);
  const [listWidth] = React.useState(LIST_PANE_WIDTH);
  const scrollRef = React.useRef<ScrollBoxRenderable | null>(null);

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

  // The conversation scrollbox uses stickyScroll (bottom), so it auto-follows new
  // messages while still letting the user scroll up. No manual scroll plumbing.

  // Deterministic viewport heights.
  const composerHeight = focus === "new" ? 6 : 5;
  const terminalDrawerHeight = activeTerminal
    ? Math.min(Math.max(Math.floor(height * 0.62), 6), Math.max(6, height - 6))
    : 0;
  const bottomReserve = activeTerminal ? terminalDrawerHeight + 1 : composerHeight + 1;
  const panesHeight = Math.max(4, height - bottomReserve);
  const listViewport = Math.max(1, panesHeight - 3);
  const termCols = Math.max(2, width - 4);
  const termRows = Math.max(2, terminalDrawerHeight - 3);
  const chatWidth = Math.max(20, width - listWidth - 4);

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

  const sendReply = () => {
    const text = reply.trim();
    if (text.length === 0) {
      // Empty prompt → Enter activates the highlighted row.
      if (state.selection?.kind === "project") store.toggleProject(state.selection.id);
      else if (state.selection?.kind === "more") store.loadMore(state.selection.id);
      return;
    }
    if (!detail) {
      store.setStatus("Select a thread (↑/↓) to send a message.");
      return;
    }
    void client
      .sendReply(detail, text)
      .catch((error) => store.setStatus(`send failed: ${String(error)}`));
    store.setStatus("Reply sent.");
    setReply("");
  };

  const submitNewThread = () => {
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
  };

  const openTerminal = () => {
    if (!detail) return;
    const project = projects.find((p) => p.id === detail.projectId);
    const cwd = detail.worktreePath ?? project?.workspaceRoot ?? process.cwd();
    setActiveTerminal({
      threadId: detail.id,
      terminalId: DEFAULT_TERMINAL_ID,
      title: detail.title,
      cwd,
      worktreePath: detail.worktreePath,
    });
  };

  useKeyboard((key) => {
    // ── Embedded terminal: forward keystrokes to the PTY ────────────────────
    if (activeTerminal) {
      if (key.ctrl && key.name === "q") {
        setActiveTerminal(null);
        return;
      }
      if (key.sequence) {
        void client.terminalWrite(activeTerminal.threadId, activeTerminal.terminalId, key.sequence).catch(() => {});
      }
      return;
    }

    // Ctrl+C always exits cleanly.
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }

    // ── New-thread dialog ───────────────────────────────────────────────────
    if (focus === "new") {
      if (key.name === "escape") {
        setDraft("");
        setFocus("compose");
        return;
      }
      if (key.name === "up") {
        setProjectIndex((index) => (index > 0 ? index - 1 : Math.max(projects.length - 1, 0)));
        return;
      }
      if (key.name === "down") {
        setProjectIndex((index) => (index + 1) % Math.max(projects.length, 1));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        submitNewThread();
        return;
      }
      return;
    }

    // ── Compose mode (default) ──────────────────────────────────────────────
    // The composer <input> owns typed characters; here we only handle
    // navigation, scrolling, action shortcuts, and submit.
    if (key.name === "up") {
      store.moveSelection(-1);
      return;
    }
    if (key.name === "down") {
      store.moveSelection(1);
      return;
    }
    if (key.name === "pageup") {
      scrollRef.current?.scrollBy({ x: 0, y: -SCROLL_STEP });
      return;
    }
    if (key.name === "pagedown") {
      scrollRef.current?.scrollBy({ x: 0, y: SCROLL_STEP });
      return;
    }

    if (key.ctrl && key.name === "n") {
      setProjectIndex(0);
      setFocus("new");
      return;
    }
    if (key.ctrl && key.name === "e") {
      openTerminal();
      return;
    }
    if (key.ctrl && key.name === "g" && detail) {
      void client.interrupt(detail.id).catch(() => {});
      store.setStatus("Interrupt sent.");
      return;
    }
    if (key.ctrl && key.name === "a" && detail && approvals[0]) {
      void client.approve(detail.id, approvals[0].requestId, "accept").catch(() => {});
      store.setStatus("Approved.");
      return;
    }
    if (key.ctrl && key.name === "r" && detail && approvals[0]) {
      void client.approve(detail.id, approvals[0].requestId, "decline").catch(() => {});
      store.setStatus("Declined.");
      return;
    }
    if (key.ctrl && key.name === "o" && detail) {
      const current = RUNTIME_MODES.indexOf(detail.runtimeMode);
      const nextMode = RUNTIME_MODES[(current + 1) % RUNTIME_MODES.length] ?? "full-access";
      void client.setRuntimeMode(detail.id, nextMode).catch(() => {});
      store.setStatus(`Mode → ${nextMode}`);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      sendReply();
      return;
    }
    if (key.name === "escape" && detail) {
      if (reply.length > 0) {
        setReply("");
        return;
      }
      void client.interrupt(detail.id).catch(() => {});
      store.setStatus("Interrupt sent.");
    }
  });

  const placeholder = detail
    ? "Type a reply, Enter to send"
    : state.selection?.kind === "project"
      ? "Enter to expand · ↑/↓ to move"
      : "Select a thread with ↑/↓";

  const hint =
    "↑/↓ threads · PgUp/PgDn scroll · Enter send · ^N new · ^E term · ^G stop · ^A/^R approve · ^O mode · ^C quit";

  return (
    <box flexDirection="column" width={width} height={height}>
      <box height={panesHeight} flexShrink={0} flexDirection="row">
        <ThreadList
          rows={listRows}
          selection={state.selection}
          moreAbove={moreAbove}
          moreBelow={moreBelow}
          width={listWidth}
          height={panesHeight}
          store={store}
        />
        <ConversationView
          detail={detail}
          approvals={approvals}
          projectHint={selectedProjectTitle}
          width={chatWidth}
          height={panesHeight}
          syntaxStyle={syntaxStyle}
          scrollRef={scrollRef}
        />
      </box>

      {activeTerminal ? (
        <box flexDirection="column" flexShrink={0}>
          <TerminalPane client={client} info={activeTerminal} cols={termCols} rows={termRows} />
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text fg={palette.dim}>keys → shell · Ctrl+Q to return</text>
          </box>
        </box>
      ) : focus === "new" ? (
        <box
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={palette.accent}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <text>
            <span fg={palette.accent}>new thread ▸ project: </span>
            <span fg={palette.text}>{projects[projectIndex]?.title ?? "(none)"}</span>
            <span fg={palette.dim}>{"  ↑/↓ change · Esc cancel"}</span>
          </text>
          <box flexDirection="row">
            <text>
              <span fg={palette.accent}>message ▸ </span>
            </text>
            <input
              value={draft}
              onChange={setDraft}
              focused
              placeholder="Describe the task…"
              flexGrow={1}
              textColor={palette.text}
              cursorColor={palette.accent}
              placeholderColor={palette.dim}
            />
          </box>
        </box>
      ) : (
        <box
          border
          borderStyle="rounded"
          borderColor={palette.accent}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
        >
          <text>
            <span fg={palette.accent}>{"› "}</span>
          </text>
          <input
            value={reply}
            onChange={setReply}
            focused
            placeholder={placeholder}
            flexGrow={1}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        </box>
      )}

      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={palette.dim}>{hint}</text>
        <text fg={palette.dim}>{` ${state.status}`}</text>
      </box>
    </box>
  );
}
