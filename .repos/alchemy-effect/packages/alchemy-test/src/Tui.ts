/**
 * Interactive opentui reporter — a k9s-style live view of the run.
 *
 * Layout:
 *   header  — run stats (pass/fail/running/queued, elapsed, import progress)
 *   list    — files with their tests nested inside (expand with enter / l)
 *   detail  — Enter on a test opens its error + captured output
 *   footer  — key hints / filter input / status toggles
 *
 * Keys (vim-style):
 *   j/k or arrows  move one line       space / ^d ^u / ^f ^b   page / half page
 *   gg / G         top / bottom        /        live type-to-filter
 *   enter          open test / toggle  h / l    collapse / expand file
 *   e / c          expand / collapse all visible files
 *   esc            back / clear filter p f n s  toggle pass/fail/pending/skipped
 *   r              retry test / file   R        retry all failed tests
 *   x              kill running test
 *   y              copy error+output   q        quit
 *
 * Mouse: the wheel scrolls the viewable content without moving the selected
 * line; clicking a row selects it. Drag-to-select text works in the detail
 * pane (enter) and copies to the clipboard on release (OSC52 + pbcopy);
 * list rows are not text-selectable — they're a recycled pool, and an
 * anchored selection highlight would leave residue as rows repaint (use `y`
 * to copy a row's details instead).
 *
 * Colors follow the terminal theme: default foreground/background
 * everywhere, ANSI palette colors only for status glyphs, and a subtle
 * theme-aware background for the selected row (neovim-style).
 *
 * Performance: the list is a fixed pool of Text rows (one per terminal
 * line) painted from the visible window only — updates are O(window), never
 * O(total tests).
 */
import {
  BoxRenderable,
  bg,
  CliRenderEvents,
  createCliRenderer,
  dim,
  green,
  red,
  ScrollBoxRenderable,
  strikethrough,
  StyledText,
  stringToStyledText,
  TextRenderable,
  yellow,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type Selection,
  type TextChunk,
} from "@opentui/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LogEntry } from "./Model.ts";
import {
  Reporter,
  type RunController,
  type RunSummary,
  type TestEvent,
  type TestMeta,
  type TestResult,
} from "./Reporter.ts";
import { captureStrayOutput } from "./StrayOutput.ts";

type Status = "queued" | "running" | "pass" | "fail" | "skip" | "todo";

/** Visibility toggle groups (`p` / `f` / `n` / `s`). */
type StatusGroup = "pass" | "fail" | "pending" | "skipped";

const groupOf = (status: Status): StatusGroup => {
  switch (status) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "queued":
    case "running":
      return "pending";
    case "skip":
    case "todo":
      return "skipped";
  }
};

const GLYPH: Record<Status, string> = {
  queued: "·",
  running: "◐",
  pass: "✓",
  fail: "✗",
  skip: "↓",
  todo: "○",
};

/** ANSI palette chunk for a status glyph — follows the terminal theme. */
const statusChunk = (status: Status, text: string): TextChunk => {
  switch (status) {
    case "pass":
      return green(text);
    case "fail":
      return red(text);
    case "running":
    case "todo":
      // todo is warning-colored: unimplemented coverage must not blend in.
      return yellow(text);
    case "queued":
    case "skip":
      return dim(text);
  }
};

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

// Captured output is replayed verbatim (ANSI is stripped at capture time).
const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

// ---------------------------------------------------------------------------
// Model: files with nested tests
// ---------------------------------------------------------------------------

interface Entry {
  readonly meta: TestMeta;
  readonly file: FileNode;
  status: Status;
  result?: TestResult;
  /** Set on TestStart; drives the live elapsed timer on running rows. */
  startedAt?: number;
  /** LIVE captured-output buffer while running (runner appends in place). */
  liveLogs?: ReadonlyArray<LogEntry>;
  /** Cached plain-text row label — recomputed only on status/result change. */
  label: string;
}

interface FileNode {
  readonly file: string;
  readonly tests: Array<Entry>;
  readonly counts: Record<Status, number>;
  /** Manual expand/collapse state; collapsed until deliberately expanded. */
  expanded: boolean | undefined;
  /** FileStart seen — the file's fiber is executing. */
  started: boolean;
  /** Currently-running file hook ("deploying…" feedback), if any. */
  hook: "beforeAll" | "afterAll" | undefined;
  hookStartedAt: number;
}

type Node =
  | {
      readonly kind: "file";
      readonly node: FileNode;
      /** Aggregate status of the tests that survived the active filters. */
      readonly status: Status;
    }
  | { readonly kind: "test"; readonly entry: Entry };

const makeCounts = (): Record<Status, number> => ({
  queued: 0,
  running: 0,
  pass: 0,
  fail: 0,
  skip: 0,
  todo: 0,
});

const entryLabel = (entry: Entry): string =>
  `${entry.meta.titlePath.join(" > ")}` +
  (entry.result !== undefined &&
  entry.status !== "queued" &&
  entry.status !== "running"
    ? ` (${formatDuration(entry.result.durationMs)})`
    : "");

const fileSummary = (node: FileNode): string => {
  const c = node.counts;
  const parts = [
    ...(c.fail > 0 ? [`${c.fail} failed`] : []),
    ...(c.running > 0 ? [`${c.running} running`] : []),
    `${c.pass}/${node.tests.length - c.skip - c.todo} passed`,
    ...(c.skip > 0 ? [`${c.skip} skipped`] : []),
    ...(c.todo > 0 ? [`${c.todo} todo`] : []),
  ];
  return parts.join(" · ");
};

const visibleFileStatus = (
  node: FileNode,
  tests: ReadonlyArray<Entry>,
): Status => {
  if (tests.some((test) => test.status === "fail")) return "fail";
  if (
    node.hook !== undefined &&
    tests.some((test) => test.status === "running" || test.status === "queued")
  ) {
    return "running";
  }
  if (tests.some((test) => test.status === "running")) return "running";
  if (tests.some((test) => test.status === "queued")) return "queued";
  if (tests.some((test) => test.status === "pass")) return "pass";
  if (tests.some((test) => test.status === "todo")) return "todo";
  return "skip";
};

/** Why a file's tests are still gray — surfaced on the file row. */
const filePhase = (node: FileNode): string | undefined => {
  if (node.hook !== undefined) {
    return `${node.hook} running (${formatDuration(Date.now() - node.hookStartedAt)})…`;
  }
  if (!node.started && node.counts.queued > 0) {
    return "waiting for a worker slot…";
  }
  return undefined;
};

class TuiState {
  readonly byId = new Map<string, Entry>();
  readonly files = new Map<string, FileNode>();
  readonly fileOrder: Array<FileNode> = [];
  readonly fileLogs = new Map<string, ReadonlyArray<LogEntry>>();
  /** Independent status groups; only failed and pending show by default. */
  readonly show: Record<StatusGroup, boolean> = {
    pass: false,
    fail: true,
    pending: true,
    skipped: false,
  };
  /** Active filter query ("" = none). Applied live on every keystroke. */
  filter = "";
  /** True while the footer is capturing filter keystrokes. */
  filterInput = false;
  detailOpen = false;
  selectedIndex = 0;
  topIndex = 0;
  /**
   * When true the viewport tracks the selection (keyboard navigation).
   * Mouse-wheel scrolling detaches it; the next keyboard move re-attaches.
   */
  viewportFollows = true;
  summary: RunSummary | undefined;
  controller: RunController | undefined;
  startedAt = Date.now();
  collectTotal = 0;
  collectDone = 0;
  dirty = true;
  readonly counts = makeCounts();

  fileNode(file: string): FileNode {
    let node = this.files.get(file);
    if (node === undefined) {
      node = {
        file,
        tests: [],
        counts: makeCounts(),
        expanded: undefined,
        started: false,
        hook: undefined,
        hookStartedAt: 0,
      };
      this.files.set(file, node);
      this.fileOrder.push(node);
    }
    return node;
  }

  upsert(meta: TestMeta, status: Status, result?: TestResult): void {
    let entry = this.byId.get(meta.id);
    if (entry === undefined) {
      const file = this.fileNode(meta.file);
      entry = { meta, file, status, label: "" };
      this.byId.set(meta.id, entry);
      file.tests.push(entry);
    } else {
      this.counts[entry.status]--;
      entry.file.counts[entry.status]--;
    }
    this.counts[status]++;
    entry.file.counts[status]++;
    entry.status = status;
    if (status === "running") {
      // (Re)started — retries included: drop the stale result so the row
      // shows a fresh live timer instead of the previous run's duration.
      entry.result = undefined;
      entry.startedAt = Date.now();
    }
    if (result !== undefined) entry.result = result;
    entry.label = entryLabel(entry);
    this.dirty = true;
  }

  allGroupsShown(): boolean {
    return (
      this.show.pass && this.show.fail && this.show.pending && this.show.skipped
    );
  }

  /**
   * Toggle a status group on/off, independently of the others (pressing `p`
   * hides passing tests and NOTHING else). Hiding every group is allowed —
   * the list is simply empty and the footer's struck-through toggle bar
   * shows why.
   */
  toggleGroup(group: StatusGroup): void {
    this.show[group] = !this.show[group];
    this.dirty = true;
  }

  private matches(entry: Entry): boolean {
    if (!this.show[groupOf(entry.status)]) return false;
    if (this.filter === "") return true;
    const haystack =
      `${entry.meta.file} ${entry.meta.titlePath.join(" ")}`.toLowerCase();
    // Every whitespace-separated word must match somewhere (AND semantics).
    return this.filter
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "")
      .every((word) => haystack.includes(word));
  }

  isExpanded(node: FileNode): boolean {
    // Expansion is ALWAYS a deliberate choice (enter / l) — failures don't
    // auto-expand their file (the red glyph + count already flag it), and
    // filtering narrows WHICH files are listed without expanding them.
    return node.expanded === true;
  }

  /** Flattened visible tree: file rows with expanded tests nested inside. */
  visible(): Array<Node> {
    const out: Array<Node> = [];
    for (const node of this.fileOrder) {
      const tests = node.tests.filter((t) => this.matches(t));
      if (tests.length === 0) continue;
      const expanded = this.isExpanded(node);
      out.push({ kind: "file", node, status: visibleFileStatus(node, tests) });
      if (expanded) {
        for (const entry of tests) out.push({ kind: "test", entry });
      }
    }
    return out;
  }

  visibleTestCount(): number {
    let count = 0;
    for (const node of this.visible()) {
      if (node.kind === "test") count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** OSC52 first (works over ssh in modern terminals), then a system tool. */
const copyToClipboard = (renderer: CliRenderer, text: string): boolean => {
  let copied = false;
  try {
    copied = renderer.copyToClipboardOSC52(text);
  } catch {
    copied = false;
  }
  try {
    const cmd =
      process.platform === "darwin"
        ? ["pbcopy"]
        : process.platform === "win32"
          ? ["clip"]
          : ["xclip", "-selection", "clipboard"];
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(text);
    proc.stdin.end();
    copied = true;
  } catch {
    // no system clipboard tool — OSC52 result stands
  }
  return copied;
};

const detailContent = (state: TuiState, entry: Entry): string => {
  const { meta, result } = entry;
  const running = entry.status === "running";
  const lines: Array<string> = [
    `${meta.file} > ${meta.titlePath.join(" > ")}`,
    `status: ${entry.status}${
      running && entry.startedAt !== undefined
        ? `  elapsed: ${formatDuration(Date.now() - entry.startedAt)}`
        : ""
    }${
      !running && result !== undefined
        ? `  duration: ${formatDuration(result.durationMs)}  retries: ${result.retries}`
        : ""
    }`,
    "",
  ];
  if (!running && result?.error !== undefined) {
    lines.push("── error ──", result.error, "");
  }
  // Finished tests show their result logs; running tests tail the LIVE
  // buffer the runner appends to.
  const logs = running ? entry.liveLogs : result?.logs;
  if (logs !== undefined && logs.length > 0) {
    lines.push("── captured output ──", formatLogs(logs), "");
  }
  const hookLogs = state.fileLogs.get(meta.file);
  if (hookLogs !== undefined && hookLogs.length > 0) {
    lines.push("── file hooks (deploy/destroy) ──", formatLogs(hookLogs));
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

interface Tui {
  readonly renderer: CliRenderer;
  readonly state: TuiState;
  readonly refresh: () => void;
  readonly quit: Promise<void>;
  readonly dispose: () => void;
}

const FOOTER_HINTS =
  "j/k · enter open · / filter · h/l fold · e/c all · r retry · R retry failed · x kill · y copy · q quit";

const makeTui = async (logFile: string): Promise<Tui> => {
  const state = new TuiState();
  /** True once the renderer is torn down — no further writes are allowed. */
  let disposed = false;

  // Ctrl+C is handled by US (exitOnCtrlC: false): opentui's built-in handler
  // destroys the renderer while our flush timer may still be queued, which
  // crashed with "TextBuffer is destroyed". We dispose first, then exit.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // Console capture is owned by StrayOutput's global patch (diverted into
    // the run log) — don't let opentui's overlay re-patch it afterwards.
    consoleMode: "disabled",
  });
  const selectionBackground = (): string =>
    renderer.themeMode === "light" ? "#d0d0d0" : "#303030";

  // Divert stray JS-level stdout/stderr writes into the run log while the
  // TUI owns the screen: anything that bypasses the per-test Effect Console
  // (third-party bridges writing to the streams directly, e.g. miniflare
  // forwarding workerd's console) would corrupt the alternate screen.
  // Installed AFTER the renderer is created — opentui captures the real
  // stream methods at construction and renders through its native library,
  // so the diversion cannot affect the TUI itself.
  const restoreStreams = captureStrayOutput(logFile);

  // No explicit colors on chrome — match the terminal's own theme.
  const header = new TextRenderable(renderer, {
    id: "header",
    content: "alchemy-test — collecting…",
    height: 1,
    width: "100%",
  });

  const list = new BoxRenderable(renderer, {
    id: "list",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
  });

  interface Row {
    readonly text: TextRenderable;
    /** Cache key of the last-applied content/style. */
    key: string;
  }
  let rows: Array<Row> = [];

  const rebuildRowPool = (): void => {
    for (const row of rows) list.remove(row.text);
    rows = [];
    const count = Math.max(renderer.terminalHeight - 2, 1);
    for (let i = 0; i < count; i++) {
      const index = i;
      const text = new TextRenderable(renderer, {
        id: `list-row-${i}`,
        width: "100%",
        height: 1,
        content: "",
        // NOT selectable: rows are a recycled pool, and opentui anchors
        // text-selection highlights on the renderable — a drag would leave
        // highlight residue behind as row content repaints under it. Copy
        // from the list with `y`; free-form text selection lives in the
        // detail pane (enter), whose content is stable.
        selectable: false,
        // Wheel scrolls the viewable content without moving the selection;
        // a click selects the row under the cursor.
        onMouse: (event: MouseEvent) => {
          if (event.type === "scroll" && event.scroll !== undefined) {
            scrollViewport(event.scroll.direction === "up" ? -3 : 3);
          }
        },
        onMouseDown: () => selectRow(index),
      });
      rows.push({ text, key: "" });
      list.add(text);
    }
  };

  const detail = new ScrollBoxRenderable(renderer, {
    id: "detail",
    width: "100%",
    flexGrow: 1,
    visible: false,
    // Tail semantics: pinned to the bottom while content grows (a running
    // test's live output); scrolling up detaches, scrolling back re-pins.
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail-text",
    content: "",
    selectable: true,
  });
  detail.add(detailText);
  /** Content of the open detail pane (for `y` copy). */
  let detailRaw = "";
  /** Entry shown in the detail pane, refreshed live while it's running. */
  let detailEntry: Entry | undefined;

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: FOOTER_HINTS,
    height: 1,
    width: "100%",
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  root.add(header);
  root.add(list);
  root.add(detail);
  root.add(footer);
  renderer.root.add(root);
  rebuildRowPool();
  renderer.on(CliRenderEvents.RESIZE, () => {
    if (disposed) return;
    rebuildRowPool();
    renderList();
  });

  /**
   * Drop any active text selection. The list is a recycled pool of row
   * renderables, so a lingering selection highlight would stick to screen
   * positions while the content underneath changes (ghost highlights after
   * a click, glyphs staying inverted through repaints).
   */
  const clearTextSelection = (): void => {
    if (!disposed && renderer.hasSelection) renderer.clearSelection();
  };

  // Drag-selected text is copied automatically on release (the terminal's
  // own CMD+C can't see the TUI's selection).
  renderer.on(
    CliRenderEvents.SELECTION,
    (selection: Selection | null | undefined) => {
      if (disposed || selection == null) return;
      if (selection.isDragging) return;
      const text = selection.getSelectedText();
      // A plain click anchors a zero-width selection — nothing to copy.
      if (text.trim().length > 1 && copyToClipboard(renderer, text)) {
        flash("selection copied ✓");
      }
      // Clear either way: the copy already happened, and a selection left
      // behind turns into ghost highlighting as the row pool repaints under
      // it. Deferred — this event is emitted from inside finishSelection,
      // which still touches the selection after the emit.
      setTimeout(clearTextSelection, 0);
    },
  );

  /**
   * Full-width run of spaces appended to single-line chrome (header/footer):
   * with transparent backgrounds, a shorter repaint would otherwise leave
   * the previous content's tail cells on screen. Overflow is clipped.
   */
  const padLine = (): string => " ".repeat(renderer.terminalWidth);

  /** Transient footer message (e.g. "copied"); reverts on the next tick. */
  let flashUntil = 0;
  const flash = (message: string): void => {
    flashUntil = Date.now() + 1500;
    footer.content = stringToStyledText(` ${message}${padLine()}`);
  };

  const updateFooter = (): void => {
    if (Date.now() < flashUntil) return;
    if (state.filterInput) {
      footer.content = stringToStyledText(
        ` /${state.filter}█   ${state.visibleTestCount()} matches   (enter close · esc clear)${padLine()}`,
      );
      return;
    }
    // Always-visible toggle bar: each group shows its hotkey and current
    // state — bright when shown, dim + struck-through when hidden.
    const toggles = (
      [
        ["pass", "p:pass"],
        ["fail", "f:fail"],
        ["pending", "n:pending"],
        ["skipped", "s:skipped"],
      ] as Array<[StatusGroup, string]>
    ).flatMap(([group, label], index) => [
      ...(index > 0 ? [dim(" ")] : []),
      state.show[group]
        ? stringToStyledText(label).chunks[0]!
        : strikethrough(dim(label)),
    ]);
    // Toggle states lead (before the hints) so they're never clipped on
    // narrow terminals — the footer truncates at the terminal width.
    const filter = state.filter !== "" ? ` │ filter: ${state.filter}` : "";
    footer.content = new StyledText([
      dim(" show: "),
      ...toggles,
      dim(`${filter} │ ${FOOTER_HINTS}${padLine()}`),
    ]);
  };

  const updateHeader = (): void => {
    const counts = state.counts;
    const elapsed = formatDuration(
      state.summary?.durationMs ?? Date.now() - state.startedAt,
    );
    const done = state.summary !== undefined;
    const collecting =
      !done && state.collectDone < state.collectTotal
        ? `  │ importing ${state.collectDone}/${state.collectTotal} files`
        : "";
    header.content = new StyledText([
      dim(" alchemy-test  "),
      green(`${GLYPH.pass} ${counts.pass}`),
      dim("  "),
      red(`${GLYPH.fail} ${counts.fail}`),
      dim("  "),
      yellow(`${GLYPH.running} ${counts.running}`),
      dim(`  ${GLYPH.queued} ${counts.queued}`),
      ...(counts.skip > 0 ? [dim(`  ${GLYPH.skip} ${counts.skip}`)] : []),
      dim(`  │ ${elapsed}${collecting}`),
      ...(done ? [dim("  │ DONE — press q to quit")] : []),
      dim(padLine()),
    ]);
  };

  /**
   * Paint the visible window into the row pool. O(window): a row's content
   * is only written when its cache key changed since the last paint.
   */
  const renderList = (): void => {
    if (state.detailOpen || disposed) return;
    const nodes = state.visible();
    const max = Math.max(nodes.length - 1, 0);
    state.selectedIndex = Math.min(state.selectedIndex, max);
    if (state.viewportFollows) {
      if (state.selectedIndex < state.topIndex) {
        state.topIndex = state.selectedIndex;
      } else if (state.selectedIndex >= state.topIndex + rows.length) {
        state.topIndex = state.selectedIndex - rows.length + 1;
      }
    }
    state.topIndex = Math.max(
      0,
      Math.min(state.topIndex, Math.max(nodes.length - rows.length, 0)),
    );

    const width = renderer.terminalWidth;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const node = nodes[state.topIndex + i];
      const isSelected =
        node !== undefined && state.topIndex + i === state.selectedIndex;

      if (node === undefined) {
        // Empty content emits no cells, so it does not erase whatever this
        // recycled screen row painted previously. Repaint the entire width.
        const emptyKey = `empty|${width}`;
        if (row.key !== emptyKey) {
          row.key = emptyKey;
          row.text.content = " ".repeat(width);
        }
        continue;
      }

      let head: string;
      let status: Status;
      let rest: string;
      if (node.kind === "file") {
        const expanded = state.isExpanded(node.node);
        status = node.status;
        head = ` ${expanded ? "▾" : "▸"} ${GLYPH[status]} `;
        const phase = filePhase(node.node);
        rest =
          `${node.node.file}  ${fileSummary(node.node)}` +
          (phase !== undefined ? `  — ${phase}` : "");
      } else {
        status = node.entry.status;
        head = `     ${GLYPH[status]} `;
        rest = node.entry.label;
        // Live elapsed timer while running (resets on retry).
        if (status === "running" && node.entry.startedAt !== undefined) {
          rest += ` (${formatDuration(Date.now() - node.entry.startedAt)}…)`;
        }
      }
      // Clip to the terminal width AND pad to it — with transparent
      // backgrounds a shorter repaint would otherwise leave the previous
      // content's tail cells on screen.
      const restWidth = Math.max(width - head.length, 0);
      rest = rest.slice(0, restWidth).padEnd(restWidth, " ");

      const key = `${isSelected ? "S" : "."}|${status}|${head}|${rest}`;
      if (row.key === key) continue;
      row.key = key;
      const chunks = [statusChunk(status, head)];
      if (rest !== "") {
        // Only the glyph is colored; the label uses the terminal's default
        // foreground (skipped rows are dimmed, todos are warning-yellow).
        if (status === "skip") {
          chunks.push(dim(rest));
        } else if (status === "todo") {
          chunks.push(yellow(rest));
        } else {
          chunks.push(...stringToStyledText(rest).chunks);
        }
      }
      // Use an explicit background instead of terminal inverse video.
      // OpenTUI's cell diff can leave inverse attributes behind when the
      // selection moves upward; a concrete background has symmetric paint
      // and clear operations in both navigation directions.
      row.text.content = new StyledText(
        isSelected ? chunks.map(bg(selectionBackground())) : chunks,
      );
    }
  };

  const moveSelection = (delta: number): void => {
    const nodes = state.visible();
    if (nodes.length === 0) return;
    state.viewportFollows = true;
    state.selectedIndex = Math.max(
      0,
      Math.min(state.selectedIndex + delta, nodes.length - 1),
    );
    renderList();
  };

  /** Scroll the viewable content without moving the selection (wheel). */
  const scrollViewport = (delta: number): void => {
    const nodes = state.visible();
    if (nodes.length === 0) return;
    state.viewportFollows = false;
    state.topIndex = Math.max(
      0,
      Math.min(state.topIndex + delta, Math.max(nodes.length - rows.length, 0)),
    );
    renderList();
  };

  /** Click on a visible row selects it (without scrolling). */
  const selectRow = (rowIndex: number): void => {
    const nodes = state.visible();
    const index = state.topIndex + rowIndex;
    if (index >= nodes.length) return;
    state.selectedIndex = index;
    renderList();
  };

  const refresh = (): void => {
    if (disposed) return;
    updateHeader();
    updateFooter();
    // Keep `dirty` set while the detail pane hides the list, so the pending
    // repaint happens when the list becomes visible again.
    if (state.dirty && !state.detailOpen) {
      state.dirty = false;
      renderList();
    }
  };

  const selectedNode = (): Node | undefined =>
    state.visible()[state.selectedIndex];

  const setExpanded = (node: FileNode, expanded: boolean): void => {
    node.expanded = expanded;
    state.dirty = true;
    renderList();
  };

  const setAllVisibleExpanded = (expanded: boolean): void => {
    const selected = selectedNode();
    const visibleFiles = new Set(
      state
        .visible()
        .map((node) => (node.kind === "file" ? node.node : node.entry.file)),
    );
    for (const file of visibleFiles) file.expanded = expanded;

    const nodes = state.visible();
    const selectedFile =
      selected?.kind === "file" ? selected.node : selected?.entry.file;
    const selectedIndex = nodes.findIndex((node) =>
      expanded && selected?.kind === "test"
        ? node.kind === "test" && node.entry === selected.entry
        : node.kind === "file" && node.node === selectedFile,
    );
    state.selectedIndex = Math.max(selectedIndex, 0);
    state.dirty = true;
    renderList();
  };

  /** Re-render the open detail pane (no-op when its content is unchanged). */
  const refreshDetail = (): void => {
    if (detailEntry === undefined) return;
    const raw = detailContent(state, detailEntry);
    if (raw === detailRaw) return;
    detailRaw = raw;
    detailText.content = stringToStyledText(raw);
  };

  const openDetail = (entry: Entry): void => {
    detailEntry = entry;
    detailRaw = detailContent(state, entry);
    detailText.content = stringToStyledText(detailRaw);
    state.detailOpen = true;
    list.visible = false;
    detail.visible = true;
    detail.focus();
    // Running test → tail the output (sticky keeps it pinned as it grows);
    // finished test → start at the top where the error is.
    detail.scrollTo(entry.status === "running" ? 1_000_000_000 : 0);
  };

  const closeDetail = (): void => {
    state.detailOpen = false;
    detailEntry = undefined;
    detail.visible = false;
    list.visible = true;
    renderList();
    refresh();
  };

  const copySelection = (): void => {
    let text: string | undefined;
    if (state.detailOpen) {
      text = detailRaw;
    } else {
      const node = selectedNode();
      if (node?.kind === "test") {
        text = detailContent(state, node.entry);
      } else if (node?.kind === "file") {
        // Copy every failure of the file plus its hook logs.
        text = node.node.tests
          .filter((t) => t.status === "fail")
          .map((t) => detailContent(state, t))
          .join("\n\n");
        if (text === "" && node.node.tests.length > 0) {
          text = detailContent(state, node.node.tests[0]!);
        }
      }
    }
    if (text === undefined || text === "") return;
    flash(
      copyToClipboard(renderer, text) ? "copied to clipboard ✓" : "copy failed",
    );
  };

  const retrySelection = (): void => {
    const controller = state.controller;
    if (controller === undefined) return;
    const node = state.detailOpen ? undefined : selectedNode();
    if (node === undefined) return;
    if (node.kind === "test") {
      if (node.entry.status === "running" || node.entry.status === "queued") {
        flash("still running — x to kill");
        return;
      }
      controller.retryTest(node.entry.meta.id);
      flash(`retrying ${node.entry.meta.name}`);
    } else {
      controller.retryFile(node.node.file);
      flash(`retrying ${node.node.file}`);
    }
  };

  const retryFailures = (): void => {
    const controller = state.controller;
    if (controller === undefined) return;
    const failed = [...state.byId.values()].filter(
      (entry) => entry.status === "fail",
    );
    for (const entry of failed) controller.retryTest(entry.meta.id);
    flash(
      failed.length === 0
        ? "no failed tests to retry"
        : `retrying ${failed.length} failed test${failed.length === 1 ? "" : "s"}`,
    );
  };

  const killSelection = (): void => {
    const controller = state.controller;
    if (controller === undefined) return;
    const node = state.detailOpen ? undefined : selectedNode();
    if (node === undefined) return;
    if (node.kind === "test") {
      if (node.entry.status !== "running") {
        flash("not running — nothing to kill");
        return;
      }
      controller.killTest(node.entry.meta.id);
      flash(`killing ${node.entry.meta.name}`);
    } else {
      for (const entry of node.node.tests) {
        if (entry.status === "running") controller.killTest(entry.meta.id);
      }
      flash(`killing running tests in ${node.node.file}`);
    }
  };

  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const onFilterKey = (key: KeyEvent): void => {
    switch (key.name) {
      case "escape":
        state.filter = "";
        state.filterInput = false;
        break;
      case "return":
      case "enter":
        state.filterInput = false;
        break;
      case "backspace":
        state.filter = state.filter.slice(0, -1);
        break;
      default: {
        // Printable, single-character inputs extend the query; the list
        // re-filters on every keystroke.
        const seq = key.sequence ?? "";
        if (seq.length === 1 && !key.ctrl && !key.meta && seq >= " ") {
          state.filter += seq;
        } else {
          return;
        }
      }
    }
    state.selectedIndex = 0;
    state.topIndex = 0;
    state.dirty = true;
    refresh();
  };

  // Vim `gg` prefix: true after a bare `g`, cleared by any other key.
  let pendingG = false;

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Ctrl+C: tear the TUI down BEFORE exiting so no queued timer callback
    // touches a destroyed renderer ("TextBuffer is destroyed").
    if (key.ctrl && key.name === "c") {
      dispose();
      process.exit(130);
    }
    if (disposed) return;
    // Keyboard input takes over from the mouse: drop any live text
    // selection so its highlight can't linger over rows that repaint.
    clearTextSelection();
    if (state.filterInput && !state.detailOpen) {
      onFilterKey(key);
      return;
    }
    switch (key.name) {
      case "q":
        resolveQuit();
        return;
      case "escape":
        if (state.detailOpen) {
          closeDetail();
        } else if (state.filter !== "") {
          state.filter = "";
          state.dirty = true;
          refresh();
        }
        return;
      case "y":
        copySelection();
        return;
      case "r":
        if (key.shift) {
          retryFailures();
        } else {
          retrySelection();
        }
        return;
      case "x":
        killSelection();
        return;
    }
    if (state.detailOpen) return; // ScrollBox handles its own keys

    // gg — jump to top (vim)
    if (key.name === "g" && !key.shift && !key.ctrl) {
      if (pendingG) {
        pendingG = false;
        moveSelection(-Number.MAX_SAFE_INTEGER);
      } else {
        pendingG = true;
      }
      return;
    }
    pendingG = false;

    // vim paging: ctrl-d/u half page, ctrl-f/b full page
    if (key.ctrl) {
      switch (key.name) {
        case "d":
          moveSelection(Math.max(Math.floor(rows.length / 2), 1));
          return;
        case "u":
          moveSelection(-Math.max(Math.floor(rows.length / 2), 1));
          return;
        case "f":
          moveSelection(rows.length);
          return;
        case "b":
          moveSelection(-rows.length);
          return;
      }
      return;
    }
    // G — jump to bottom (vim)
    if (key.name === "g" && key.shift) {
      moveSelection(Number.MAX_SAFE_INTEGER);
      return;
    }
    switch (key.name) {
      case "/":
        state.filterInput = true;
        refresh();
        return;
      case "space":
      case " ":
        // space pages forward (less/vim style)
        moveSelection(rows.length);
        return;
      case "return":
      case "enter": {
        const node = selectedNode();
        if (node === undefined) return;
        if (node.kind === "file") {
          setExpanded(node.node, !state.isExpanded(node.node));
        } else {
          openDetail(node.entry);
        }
        return;
      }
      case "left":
      case "h": {
        const node = selectedNode();
        if (node === undefined) return;
        // On a test row, collapse the parent file and land on it.
        const target = node.kind === "file" ? node.node : node.entry.file;
        setExpanded(target, false);
        const index = state
          .visible()
          .findIndex((n) => n.kind === "file" && n.node === target);
        if (index >= 0) {
          state.selectedIndex = index;
          renderList();
        }
        return;
      }
      case "right":
      case "l": {
        const node = selectedNode();
        if (node?.kind === "file") setExpanded(node.node, true);
        return;
      }
      case "e":
        setAllVisibleExpanded(true);
        return;
      case "c":
        setAllVisibleExpanded(false);
        return;
      case "up":
      case "k":
        moveSelection(-1);
        return;
      case "down":
      case "j":
        moveSelection(1);
        return;
      case "pageup":
        moveSelection(-rows.length);
        return;
      case "pagedown":
        moveSelection(rows.length);
        return;
      case "home":
        moveSelection(-Number.MAX_SAFE_INTEGER);
        return;
      case "end":
        moveSelection(Number.MAX_SAFE_INTEGER);
        return;
      // Independent status-group visibility toggles: each key flips ONLY its
      // own group. Hiding all four leaves the list empty (no auto-reset).
      case "p":
        state.toggleGroup("pass");
        break;
      case "f":
        state.toggleGroup("fail");
        break;
      case "n":
        state.toggleGroup("pending");
        break;
      case "s":
        state.toggleGroup("skipped");
        break;
      default:
        return;
    }
    state.selectedIndex = 0;
    state.topIndex = 0;
    refresh();
  });

  // Single flush loop: repaints the visible window at most 10x/s and ONLY
  // when test data changed; otherwise it just ticks the elapsed-time header
  // while the run is live.
  const interval = setInterval(() => {
    if (disposed) return;
    // Tail the open detail pane while its test is running.
    if (state.detailOpen) refreshDetail();
    // Live elapsed timers: hook phases on file rows and running test rows.
    if (state.counts.running > 0) state.dirty = true;
    for (const node of state.fileOrder) {
      if (node.hook !== undefined) state.dirty = true;
    }
    if (state.dirty) {
      refresh();
    } else if (state.summary === undefined || Date.now() < flashUntil + 100) {
      updateHeader();
      updateFooter();
    }
  }, 100);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    restoreStreams();
    try {
      renderer.destroy();
    } catch {
      // Never let teardown mask the run's real outcome.
    }
  };

  return {
    renderer,
    state,
    refresh: () => {
      if (!disposed) refresh();
    },
    quit,
    dispose,
  };
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const onEvent = (tui: Tui, event: TestEvent): void => {
  const { state } = tui;
  switch (event._tag) {
    case "CollectStart":
      state.collectTotal = event.files.length;
      break;
    case "FileCollected":
      state.collectDone++;
      break;
    case "RunStart":
      state.startedAt = Date.now();
      for (const meta of event.tests) state.upsert(meta, "queued");
      break;
    case "FileStart":
      state.fileNode(event.file).started = true;
      // Live hook-log buffer — grows in place as deploy/destroy run.
      if (event.logs !== undefined) {
        state.fileLogs.set(event.file, event.logs);
      }
      break;
    case "HookStart": {
      const node = state.fileNode(event.file);
      node.hook = event.hook;
      node.hookStartedAt = Date.now();
      break;
    }
    case "HookEnd":
      state.fileNode(event.file).hook = undefined;
      break;
    case "TestStart": {
      state.upsert(event.test, "running");
      const entry = state.byId.get(event.test.id);
      if (entry !== undefined) entry.liveLogs = event.logs;
      break;
    }
    case "TestEnd":
      state.upsert(event.test, event.result.status, event.result);
      break;
    case "FileEnd": {
      const node = state.fileNode(event.file);
      node.hook = undefined;
      state.fileLogs.set(event.file, event.logs);
      if (event.error !== undefined) {
        // Surface import/hook failures as a synthetic failed entry.
        state.upsert(
          {
            id: `${event.file} > [file]`,
            file: event.file,
            titlePath: ["[file]"],
            name: "[file]",
          },
          "fail",
          {
            status: "fail",
            durationMs: 0,
            error: event.error,
            logs: event.logs,
            retries: 0,
          },
        );
      }
      break;
    }
    case "RunEnd":
      state.summary = event.summary;
      // Final state should render immediately, not on the next tick.
      state.dirty = true;
      tui.refresh();
      return;
    default:
      break;
  }
  // Everything else just marks the state dirty; the flush interval batches
  // repaints (a burst of TestEnd events must not repaint per event).
  state.dirty = true;
};

export const TuiReporter = (logFile: string): Layer.Layer<Reporter> =>
  Layer.effect(Reporter)(
    Effect.gen(function* () {
      const tui = yield* Effect.acquireRelease(
        Effect.promise(() => makeTui(logFile)),
        (t) => Effect.sync(() => t.dispose()),
      );
      return {
        emit: (event) => Effect.sync(() => onEvent(tui, event)),
        waitForExit: () => Effect.promise(() => tui.quit),
        attachController: (controller) =>
          Effect.sync(() => {
            tui.state.controller = controller;
          }),
      };
    }),
  );
