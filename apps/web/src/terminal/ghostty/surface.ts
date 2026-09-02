import { isMacPlatform } from "../../lib/utils";
import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "../../lib/selectionActions";
import { collectWrappedTerminalLinkLine, extractTerminalLinks } from "../../terminal-links";
import {
  GhosttyTerminalCore,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "./core";
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  type GhosttyCellRange,
  type GhosttyCellMetrics,
} from "./renderer";
import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";
import { isMonospaceFamily } from "../../appearanceFonts";

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
// The glyph fallbacks only supply symbols the text faces are missing (powerline
// separators, devicons, and other private-use prompt symbols), so shells
// configured for a locally installed Nerd Font keep their prompt glyphs no
// matter which text face is active.
const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';
// The platform's own monospace faces; concrete names only, because an
// unknown keyword (like ui-monospace) makes canvas font shorthand parsing
// reject the whole string.
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' + TERMINAL_GLYPH_FALLBACKS;
const CONTENT_PADDING = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 18;
/** Half a blink cycle: the visible and hidden phases are equally long. */
const CURSOR_BLINK_INTERVAL_MS = 500;
const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";
const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;

/** Requested terminal font; omitted fields fall back to the defaults. */
export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

let symbolsFontLoad: Promise<void> | null = null;

/**
 * Register the bundled symbols-only Nerd Font once per page. It loads lazily
 * with the first terminal, and because it carries no regular text glyphs it
 * composes with any text face without changing metrics — prompt symbols and
 * devicons render even on machines without a locally installed Nerd Font.
 */
function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();
  return symbolsFontLoad;
}

function quoteTerminalFontFamilies(list: string): string {
  return list
    .split(",")
    .map((name) => {
      const bare = name.trim();
      if (bare.length === 0) return "";
      if (/^(['"]).*\1$/.test(bare)) return bare;
      if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
      return `"${bare.replaceAll('"', "")}"`;
    })
    .filter((name) => name.length > 0)
    .join(", ");
}

function uncheckedTerminalFontFamily(family?: string): string {
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  return custom.length === 0
    ? DEFAULT_TERMINAL_FONT_FAMILY
    : `${custom}, ${TERMINAL_GLYPH_FALLBACKS}`;
}

export function terminalFontFamily(family?: string): string {
  // Quote non-ident names ("3270 Nerd Font", "M+ 1m"): an unquoted one makes
  // the whole canvas font string invalid and the assignment silently no-ops.
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  if (custom.length === 0) return DEFAULT_TERMINAL_FONT_FAMILY;
  // The grid places the cursor and selection on one cell advance, so a
  // proportional face would draw its text narrower than its own cells. Refuse
  // it here rather than render a ragged grid with a stranded cursor.
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;
  // A custom face keeps the glyph fallbacks so prompt symbols stay covered.
  return uncheckedTerminalFontFamily(custom);
}

/** Load every style the renderer can request, then validate the actual face. */
export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<unknown>;
    readonly resolve: (family: string | undefined) => string;
  },
): Promise<string> {
  const candidate = uncheckedTerminalFontFamily(family);
  const load =
    environment?.load ?? ((font: string, text: string) => document.fonts.load(font, text));
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {
    // The fixed-width fallback stack remains available if a face cannot load.
  }
  return (environment?.resolve ?? terminalFontFamily)(family);
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}

/**
 * Whether the cursor should keep toggling. An unfocused surface draws a steady
 * hollow cursor instead of blinking, and a reduced-motion reader gets a steady
 * cursor too rather than a permanently animating element.
 */
export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}

/**
 * Vertical origin of the grid inside the mount. While content is shorter than
 * the viewport the grid sits at the top like a fresh terminal. Once scrollback
 * exists the prompt lives on the bottom row, so the grid anchors to the bottom
 * edge instead: the sub-row remainder moves above row 0 and resizing within a
 * row boundary keeps the prompt pinned instead of snapping up and down.
 */
export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding;
  const slack = mountHeight - padding * 2 - rows * cellHeight;
  return padding + Math.max(0, slack);
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number,
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  metrics: Pick<GhosttyCellMetrics, "width" | "height">;
  padding: number;
  originY: number;
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options;
  const gridX = clientX - bounds.left - padding;
  const gridY = clientY - bounds.top - originY;
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null;
  }
  return {
    x: Math.floor(gridX / metrics.width),
    y: Math.floor(gridY / metrics.height),
  };
}

function terminalRowText(row: GhosttySnapshot["rowData"][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || " ").join("");
  return trimRight ? text.trimEnd() : text;
}

function terminalColumnOffset(row: GhosttySnapshot["rowData"][number], column: number): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  return offset;
}

export function terminalLinkAtPosition(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): string | null {
  return terminalLinkAtPositionWithRange(rows, rowIndex, column)?.text ?? null;
}

export interface TerminalLinkWithRange {
  readonly text: string;
  readonly range: GhosttyCellRange;
}

function terminalColumnAtOffset(row: GhosttySnapshot["rowData"][number], offset: number): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    const nextOffset = terminalColumnOffset(row, column + 1);
    if (offset < nextOffset) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): TerminalLinkWithRange | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  // Only viewport rows are available: a wrapped line whose head scrolled above
  // the viewport would resolve a truncated match into a wrong link.
  const firstSegment = wrappedLine.segments[0];
  if (firstSegment && rows[firstSegment.bufferLineNumber - 1]?.isWrapContinuation) {
    return null;
  }
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const lastSegment = wrappedLine.segments.at(-1);
  const lastRow = lastSegment ? rows[lastSegment.bufferLineNumber - 1] : undefined;
  // Ghostty's soft-wrap flag is authoritative: when the last collected row
  // still wraps onward, its continuation is outside the viewport.
  const continuesBelowViewport = lastRow !== undefined && lastRow.wrapsToNext;
  const offset = segment.startIndex + terminalColumnOffset(row, column);
  for (const match of extractTerminalLinks(wrappedLine.text)) {
    if (offset >= match.start && offset < match.end) {
      // A truncated tail must not activate as a complete link.
      if (match.end === wrappedLine.text.length && continuesBelowViewport) return null;
      const startSegment = wrappedLine.segments.find(
        (value) => match.start >= value.startIndex && match.start < value.endIndex,
      );
      const endSegment = wrappedLine.segments.find(
        (value) => match.end - 1 >= value.startIndex && match.end - 1 < value.endIndex,
      );
      const startRow = startSegment ? rows[startSegment.bufferLineNumber - 1] : undefined;
      const endRow = endSegment ? rows[endSegment.bufferLineNumber - 1] : undefined;
      if (!startSegment || !endSegment || !startRow || !endRow) return null;
      return {
        text: match.text,
        range: {
          start: {
            x: terminalColumnAtOffset(startRow, match.start - startSegment.startIndex),
            y: startSegment.bufferLineNumber - 1,
          },
          end: {
            x: terminalColumnAtOffset(endRow, match.end - 1 - endSegment.startIndex),
            y: endSegment.bufferLineNumber - 1,
          },
        },
      };
    }
  }
  return null;
}

export function terminalLinkAtColumn(row: GhosttySnapshot["rowData"][number], column: number) {
  return terminalLinkAtPosition([row], 0, column);
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "c") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

/**
 * Canvas terminals have no DOM selection. Native copy and Electron's Edit
 * menu `role: "copy"` both read the focused textarea, so an empty IME field
 * writes blankness to the clipboard. Park the Ghostty selection there first.
 */
export function primeTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value" | "select">,
  selection: string,
): void {
  input.value = selection;
  if (selection.length === 0) return;
  input.select();
}

export function clearPrimedTerminalCopyInput(
  input: Pick<HTMLTextAreaElement, "value">,
  primedSelection: string,
): void {
  // Only blank the copy we parked. The same textarea holds the IME candidate;
  // wiping whatever is there would cancel CJK composition.
  if (primedSelection.length === 0 || input.value !== primedSelection) return;
  input.value = "";
}

/**
 * Only a copy event that actually received the selection may cancel the
 * clipboard.writeText fallback. Claiming without clipboardData (Electron's
 * menu Copy) used to preventDefault an empty write and skip the fallback,
 * which is how Cmd+C copied blankness.
 */
export function applyTerminalCopyEvent(
  selection: string,
  clipboardData: { setData: (type: string, data: string) => void } | null | undefined,
): { preventDefault: boolean; claimWriteFallback: boolean } {
  if (selection.length === 0 || !clipboardData) {
    return { preventDefault: false, claimWriteFallback: false };
  }
  clipboardData.setData("text/plain", selection);
  return { preventDefault: true, claimWriteFallback: true };
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  const key = event.key.toLowerCase();
  if (key === "insert" && !isMacPlatform(platform)) {
    return event.shiftKey && !event.ctrlKey && !event.metaKey;
  }
  if (key !== "v") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, "inputType">): boolean {
  return (
    event.inputType === "" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

/** IME keydowns must not touch the hidden textarea; it holds the candidate. */
export function isTerminalCompositionKey(
  event: Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">,
  composing: boolean,
): boolean {
  return event.isComposing || composing || event.key === "Process" || event.keyCode === 229;
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, "getModifierState" | "key">,
): boolean {
  return event.getModifierState("AltGraph") && [...event.key].length === 1;
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

type TerminalMouseAction = "press" | "release" | "motion";

export function resolveTerminalMouseData(
  action: TerminalMouseAction,
  data: string,
  previousMotionData: string,
): { readonly send: boolean; readonly nextMotionData: string } {
  const nextMotionData = action === "motion" ? data : "";
  return {
    send: data.length > 0 && (action !== "motion" || data !== previousMotionData),
    nextMotionData,
  };
}

export function resolveTerminalMouseTrackingState(
  previousTracking: boolean,
  tracking: boolean,
  motionData: string,
): { readonly tracking: boolean; readonly motionData: string } {
  return {
    tracking,
    motionData: previousTracking === tracking ? motionData : "",
  };
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  cellHeight: number,
  viewportRows: number,
  remainder: number,
): { readonly rows: number; readonly remainder: number } {
  // deltaMode: 0 pixels, 1 lines, 2 pages.
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY;
  const total = remainder + pixels / cellHeight;
  const rows = Math.trunc(total);
  return { rows, remainder: total - rows };
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return "";
  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? "\u001bOA"
        : "\u001b[A"
      : applicationCursorKeys
        ? "\u001bOB"
        : "\u001b[B";
  return sequence.repeat(Math.abs(rows));
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= SELECTION_MULTI_CLICK_INTERVAL_MS &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4;
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  /**
   * A right-click the running application did not claim through mouse
   * reporting. The host owns the menu, so it also owns preventing the browser
   * default — whose Paste entry can never reach a canvas terminal.
   */
  readonly onContextMenu?: (event: MouseEvent) => void;
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  cols = 1;
  rows = 1;

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyTerminalSurfaceOptions;
  private metrics: GhosttyCellMetrics;
  private fontFamily: string;
  private requestedFontFamily: string | undefined;
  private fontSize: number;
  private fontEpoch = 0;
  private pendingFontEpoch: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly scrollbarThumb: HTMLDivElement;
  private snapshot: GhosttySnapshot | null = null;
  private frame = 0;
  private cursorTimer: number | null = null;
  private compositionInputToSuppress: string | null = null;
  private compositionSuppressionTimer: number | null = null;
  private cursorOn = true;
  private renderedCursorY: number | null = null;
  private forceFullRender = true;
  private scrollbarDirty = true;
  private scrollbarState: GhosttyScrollbar | null = null;
  private scrollbarPointerId: number | null = null;
  private scrollbarPointerOffset = 0;
  private disposed = false;
  private resizeNotifyTimer: number | null = null;
  private originY = CONTENT_PADDING;
  private mountHeight = 0;
  private selectionEnd: { x: number; y: number } | null = null;
  private selectionAnchorScreen: { x: number; y: number } | null = null;
  private selectionEndScreen: { x: number; y: number } | null = null;
  private selectionMode: "cell" | "word" | "line" = "cell";
  // Word/line selection base in screen coordinates so streaming output cannot
  // shift the origin of a drag selection.
  private selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  private selectionScrollTimer: number | null = null;
  private selectionScrollDelta = 0;
  private selectionPointer: { x: number; y: number } | null = null;
  private mouseReportingPointerId: number | null = null;
  private mouseReportingButton: number | null = null;
  private linkActivationPointerId: number | null = null;
  private hoveredLink: TerminalLinkWithRange | null = null;
  private hoverPointer: { x: number; y: number } | null = null;
  private linkModifierActive = false;
  private selectionClickSequence: TerminalSelectionClickSequence | null = null;
  private selectionMoved = false;
  private composing = false;
  private focused = false;
  private resizeNotified = false;
  private canvasConfigured = false;
  private theme: GhosttyTheme;
  private readonly suppressedKeyCodes = new Set<string>();
  private pasteShortcutToken = 0;
  private copyShortcutToken = 0;
  private clearSelectionAfterCopy = false;
  private primedCopySelection = "";
  private wheelRemainder = 0;
  private lastMouseMotionData = "";
  private mouseAnyEventTracking = false;
  private dprMedia: MediaQueryList | null = null;
  // Read live on every blink decision, and watched so that dropping the
  // preference restarts a blink cycle that has no timer left to notice it.
  private readonly reducedMotionMedia = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  private inputLeft = -1;
  private inputTop = -1;

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    scrollbar: HTMLDivElement,
    scrollbarThumb: HTMLDivElement,
    context: CanvasRenderingContext2D,
    core: GhosttyTerminalCore,
    metrics: GhosttyCellMetrics,
    fontFamily: string,
    options: GhosttyTerminalSurfaceOptions,
  ) {
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.scrollbar = scrollbar;
    this.scrollbarThumb = scrollbarThumb;
    this.context = context;
    this.core = core;
    this.mouseAnyEventTracking = core.isMouseAnyEventTracking();
    this.metrics = metrics;
    this.options = options;
    this.theme = options.theme;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = options.font?.family;
    this.fontSize = terminalFontSize(options.font?.size);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener("change", this.onReducedMotionChange);
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
    this.resizeObserver.observe(mount);
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    const canvas = document.createElement("canvas");
    canvas.className = "block size-full cursor-text";
    canvas.setAttribute("aria-hidden", "true");

    const input = document.createElement("textarea");
    input.className = "t3-ghostty-input";
    input.setAttribute("aria-label", "Terminal input");
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText =
      "position:absolute;left:4px;top:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;";

    const scrollbar = document.createElement("div");
    scrollbar.className =
      "group absolute top-1 right-px bottom-1 z-1 w-[var(--app-scrollbar-width)] cursor-default touch-none";
    scrollbar.setAttribute("role", "scrollbar");
    scrollbar.setAttribute("aria-label", "Terminal scrollback");
    scrollbar.setAttribute("aria-orientation", "vertical");
    scrollbar.tabIndex = 0;
    scrollbar.hidden = true;
    const scrollbarThumb = document.createElement("div");
    scrollbarThumb.className =
      "absolute inset-x-px top-0 rounded-[3px] bg-[var(--app-scrollbar-thumb)] transition-[background-color] duration-[120ms] ease-[ease-out] group-hover:bg-[var(--app-scrollbar-thumb-hover)] group-focus-visible:bg-[var(--app-scrollbar-thumb-hover)]";
    scrollbar.append(scrollbarThumb);
    mount.replaceChildren(canvas, input, scrollbar);

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    // An opaque canvas backing store initializes to solid black, and the font
    // and WASM loads below leave it on screen for the whole setup window; paint
    // the theme background first so the mount never flashes a black box.
    context.fillStyle = `rgb(${options.theme.background.r}, ${options.theme.background.g}, ${options.theme.background.b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = terminalFontSize(options.font?.size);
    try {
      // Cell metrics must come from the faces that will render; measuring before
      // the bundled webfonts load would size the grid from a fallback font.
      await ensureTerminalSymbolsFont();
    } catch {
      // Metrics fall back to whichever faces are already available.
    }
    const fontFamily = await loadTerminalFontFamily(options.font?.family, fontSize);
    const metrics = measureGhosttyCell(context, fontSize, fontFamily);
    const grid = terminalGridSize(mount.clientWidth, mount.clientHeight, metrics, CONTENT_PADDING);
    const core = await GhosttyTerminalCore.create(
      grid.cols,
      grid.rows,
      metrics.width,
      metrics.height,
      options.theme,
      options.onData,
    );
    const surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      scrollbar,
      scrollbarThumb,
      context,
      core,
      metrics,
      fontFamily,
      options,
    );
    surface.fit();
    surface.requestRender();
    return surface;
  }

  write(data: string): void {
    if (this.disposed) return;
    this.core.write(data);
    this.synchronizeMouseTrackingState();
    // Restart the blink cycle from the visible phase so the cursor never sits
    // invisible through a stream of output or a burst of typing echo.
    this.cursorOn = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  resetAndWrite(data: string): void {
    if (this.disposed) return;
    this.lastMouseMotionData = "";
    this.core.resetAndWrite(data);
    this.synchronizeMouseTrackingState();
    // A replayed session starts from the visible phase like any other write:
    // reattaching mid-blink must not open on an invisible cursor.
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed) return;
    this.theme = theme;
    this.core.setTheme(theme);
    this.forceFullRender = true;
    this.requestRender();
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return;
    const fontSize = terminalFontSize(font.size);
    // The fields only change together with their metrics after the load, and
    // the epoch lets the newest overlapping call win regardless of load order.
    const epoch = ++this.fontEpoch;
    this.pendingFontEpoch = epoch;
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize);
    if (this.disposed || epoch !== this.fontEpoch) return;
    this.pendingFontEpoch = null;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font.family;
    this.fontSize = fontSize;
    this.applyFontMetrics();
  }

  private applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
    // Cached IME textarea coordinates are stale in the new cell geometry.
    this.inputLeft = -1;
    this.inputTop = -1;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.fit();
    this.requestRender();
  }

  private readonly onReducedMotionChange = () => {
    if (this.disposed) return;
    // Nothing else wakes an idle steady cursor: the blink timer only reschedules
    // from a render, and reduced motion is exactly the state that stopped it.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onFontsLoaded = () => {
    if (this.disposed) return;
    // The explicit load validates every style and applies the newest request.
    // Its own loading events must not revalidate the previously applied face.
    if (this.pendingFontEpoch !== null) return;
    // A face may become available after an earlier fallback measurement. Run
    // the fixed-width guard again before using its newly loaded metrics.
    const fontFamily = terminalFontFamily(this.requestedFontFamily);
    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.applyFontMetrics();
      return;
    }
    // A face that finished loading after the initial measurement changes glyph
    // advances; re-measure and refit so the grid matches what actually renders.
    const metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    if (
      metrics.width === this.metrics.width &&
      metrics.height === this.metrics.height &&
      metrics.baseline === this.metrics.baseline
    ) {
      return;
    }
    this.applyFontMetrics();
  };

  fit(): boolean {
    if (this.disposed) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) return false;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    let shouldRender = false;
    // The DPR transform must be installed even when the target size happens to
    // equal the canvas default 300x150 backing store, so the first fit always
    // schedules a canvas configuration.
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.canvasConfigured = true;
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }
    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING);
    this.mountHeight = height;
    // onResize is the only PTY resize channel, so the first successful fit must
    // notify even when the measured grid equals the 1x1 construction sentinel.
    if (grid.cols !== this.cols || grid.rows !== this.rows || !this.resizeNotified) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.core.resize(grid.cols, grid.rows, this.metrics.width, this.metrics.height);
      this.notifyResize();
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }
    // Rendering synchronously keeps the repaint inside the same frame as the
    // layout change: ResizeObserver fires before paint, so the browser never
    // composites the old backing store stretched into the new element box.
    if (shouldRender) this.renderFrame();
    return true;
  }

  /**
   * The local grid reflows immediately, but the PTY only hears about settled
   * dimensions: notifying on every drag step makes the shell reprint its
   * prompt mid-drag, which reads as jitter.
   */
  private notifyResize(): void {
    this.resizeNotified = true;
    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null;
      if (!this.disposed) this.options.onResize(this.cols, this.rows);
    }, 150);
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /**
   * Pastes clipboard text read by the host (context menu) with the same
   * bracketed-paste encoding as a native paste event. The read joins the same
   * race the paste shortcut uses — the token is claimed before it starts — so
   * a shortcut or native paste arriving during the read supersedes this one
   * instead of both reaching the shell.
   */
  async pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const token = ++this.pasteShortcutToken;
    const text = await readText();
    if (this.disposed || this.pasteShortcutToken !== token || !isCurrent()) return;
    // As in every paste path, delivering bumps the token so a clipboard read
    // still in flight cannot land after this text reaches the shell.
    this.pasteShortcutToken += 1;
    if (text.length === 0) return;
    const encoded = this.core.encodePaste(text);
    if (encoded.length > 0) this.options.onData(encoded);
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.hasSelection())
      return null;
    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x);
    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen };
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const position = this.getSelectionPosition();
    if (!position) return null;
    const viewportEnd = this.core.screenPointToViewport(position.end.x, position.end.y);
    if (!viewportEnd) return null;
    const bounds = this.canvas.getBoundingClientRect();
    return {
      right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * this.metrics.width,
      bottom: bounds.top + this.originY + (viewportEnd.y + 1) * this.metrics.height,
    };
  }

  clearSelection(): void {
    this.clearPrimedCopy();
    this.core.clearSelection();
    this.selectionEnd = null;
    this.selectionAnchorScreen = null;
    this.selectionEndScreen = null;
    this.selectionMode = "cell";
    this.selectionBase = null;
    this.setSelectionAutoscroll(0);
    this.options.onSelectionChange();
    // Selection highlights span rows Ghostty may not mark dirty for this change.
    this.forceFullRender = true;
    this.requestRender();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    this.dprMedia = null;
    this.reducedMotionMedia?.removeEventListener("change", this.onReducedMotionChange);
    if (this.selectionScrollTimer !== null) window.clearInterval(this.selectionScrollTimer);
    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer);
      this.resizeNotifyTimer = null;
      // Flush the settled dimensions so the PTY keeps the final size even when
      // the surface unmounts inside the debounce window.
      this.options.onResize(this.cols, this.rows);
    }
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
    }
    this.removeEvents();
    this.core.dispose();
    if (
      this.canvas.parentElement === this.mount ||
      this.input.parentElement === this.mount ||
      this.scrollbar.parentElement === this.mount
    ) {
      this.canvas.remove();
      this.input.remove();
      this.scrollbar.remove();
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.updateLinkModifier(event);
    // Presses handled outside the terminal must also swallow their release:
    // beforeKey runs side effects (keybindings, navigation sends), so it cannot
    // be consulted again on keyup, and Kitty report-event-types sessions would
    // otherwise receive a release for a press the shell never saw.
    if (isTerminalAltGraphText(event) || !this.options.beforeKey(event)) {
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      // A plain Ctrl+C/Cmd+C fires the browser's native copy event, caught in
      // onCopyEvent; not preventing the default keeps that path alive. WebKit
      // omits the keyboard copy event without a DOM selection, so race the
      // clipboard write against it the same way paste races its read. The
      // Shift variant has no native event (Chrome binds Ctrl+Shift+C to
      // inspect), so synthesize one with execCommand("copy").
      const selection = this.getSelection();
      this.primeCopy(selection);
      if (event.shiftKey) {
        event.preventDefault();
        document.execCommand("copy");
      } else {
        // A plain Ctrl+C is also SIGINT on non-mac: clear the selection once
        // it copies so the next Ctrl+C reaches the shell. The Shift chord and
        // Cmd+C are copy-only, so they keep the selection; resetting the flag
        // up front also drops any clear owed by an earlier gesture that never
        // completed.
        this.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform(navigator.platform);
        const clipboard = navigator.clipboard;
        if (typeof clipboard?.writeText === "function") {
          // Defer the write past the default action: the native copy event
          // (dispatched synchronously with the default action) claims the
          // token first when it actually writes, and the write covers browsers
          // whose shortcut produces no copy event. The primed textarea is what
          // Electron's edit-menu Copy reads if it runs after this handler.
          const token = ++this.copyShortcutToken;
          void Promise.resolve().then(() => {
            if (this.disposed || this.copyShortcutToken !== token) return;
            void clipboard.writeText(selection).then(
              () => {
                // The write may have been superseded while in flight; only
                // touch the selection if this gesture still owns the token.
                if (this.disposed || this.copyShortcutToken !== token) return;
                if (this.clearSelectionAfterCopy) {
                  this.clearSelectionAfterCopy = false;
                  this.clearSelection();
                }
              },
              () => {
                // The write failed and the native event has already had its
                // chance, so nothing copied and no clear is owed by this
                // gesture; a newer one may have just set the flag, so only
                // drop it if this gesture still owns the token.
                if (this.copyShortcutToken === token) {
                  this.clearSelectionAfterCopy = false;
                }
              },
            );
          });
        }
      }
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalPasteShortcut(event)) {
      this.suppressedKeyCodes.add(event.code);
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.readText === "function") {
        // Race the async clipboard read against the browser's own paste event:
        // the native event (dispatched synchronously with the default action)
        // always claims the token first when it fires, and the read covers
        // browsers whose paste shortcut produces no paste event. Not preventing
        // the default keeps the native path alive when the read is denied.
        const token = ++this.pasteShortcutToken;
        void clipboard.readText().then(
          (text) => {
            if (this.disposed || this.pasteShortcutToken !== token) return;
            this.pasteShortcutToken += 1;
            if (text.length > 0) this.options.onData(this.core.encodePaste(text));
          },
          () => {
            // Clipboard read denied; the native paste event remains the path.
          },
        );
      }
      return;
    }
    // keyCode 229 is Safari's only signal that this keydown opens an IME
    // composition; encoding it would double the committed text. Do not blank
    // the textarea first: onInput leaves the in-progress candidate there.
    if (isTerminalCompositionKey(event, this.composing)) {
      return;
    }
    this.clearPrimedCopy();
    const data = this.core.encodeKey(event);
    if (data.length === 0) return;
    this.suppressedKeyCodes.delete(event.code);
    event.preventDefault();
    event.stopPropagation();
    this.options.onData(data);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.updateLinkModifier(event);
    if (this.suppressedKeyCodes.delete(event.code)) return;
    if (isTerminalCompositionKey(event, this.composing)) {
      return;
    }
    // Ghostty's encoder only emits release codes when the terminal enabled the
    // Kitty report-event-types flag, so legacy sessions send nothing here.
    const data = this.core.encodeKey(event, "release");
    if (data.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.onData(data);
  };

  private readonly onFocus = () => {
    this.focused = true;
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onBlur = () => {
    this.focused = false;
    this.linkModifierActive = false;
    this.refreshHoveredLink();
    // Suppressions survive blur deliberately: a shortcut that moves focus (for
    // example terminal-toggle) must still swallow its own keyup if focus comes
    // back before release. Stale entries are harmless — an encoding keydown
    // always removes its code first.
    // The steady unfocused hollow cursor must not inherit an off blink phase.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onDevicePixelRatioChange = () => {
    this.watchDevicePixelRatio();
    this.fit();
  };

  private watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    // A resolution media query only fires once for the ratio it was created at,
    // so re-arm it after every change (monitor moves, browser zoom).
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener("change", this.onDevicePixelRatioChange);
  }

  private primeCopy(selection: string): void {
    this.primedCopySelection = selection;
    primeTerminalCopyInput(this.input, selection);
  }

  private clearPrimedCopy(): void {
    clearPrimedTerminalCopyInput(this.input, this.primedCopySelection);
    this.primedCopySelection = "";
  }

  private readonly onCopyEvent = (event: ClipboardEvent) => {
    const selection = this.hasSelection() ? this.getSelection() : this.input.value;
    // Menu-role Copy never hits the keydown primer. The native action reads
    // this.input, so park the current selection first — including when
    // clipboardData is missing and we must not preventDefault.
    this.primeCopy(selection);
    const result = applyTerminalCopyEvent(selection, event.clipboardData);
    if (result.preventDefault) event.preventDefault();
    if (result.claimWriteFallback) {
      // The native event actually wrote the selection; drop the in-flight
      // writeText so a late resolution cannot clobber a later user copy.
      this.copyShortcutToken += 1;
      if (this.clearSelectionAfterCopy) {
        this.clearSelectionAfterCopy = false;
        this.clearSelection();
      }
    }
  };

  private readonly onPaste = (event: ClipboardEvent) => {
    // Always suppress the browser's default insertion: content the textarea
    // would receive (for example an html-only clipboard converted to text)
    // leaks through onInput without bracketed-paste encoding.
    event.preventDefault();
    const data = event.clipboardData?.getData("text/plain") ?? "";
    if (data.length === 0) return;
    // The native paste won the race with actual text; a pending clipboard read
    // must not double. An empty native paste leaves the read as the only path.
    this.pasteShortcutToken += 1;
    this.options.onData(this.core.encodePaste(data));
  };

  private readonly onCompositionStart = () => {
    this.clearPrimedCopy();
    this.clearCompositionInputSuppression();
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    const data = this.input.value || event.data;
    if (data.length > 0) this.options.onData(data);
    this.input.value = "";
    this.compositionInputToSuppress = data;
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null;
      this.compositionSuppressionTimer = null;
    }, 100);
  };

  private readonly onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (this.composing || inputEvent.isComposing) return;
    const data = this.input.value || inputEvent.data || "";
    if (data === this.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
      this.clearCompositionInputSuppression();
      this.input.value = "";
      return;
    }
    this.clearCompositionInputSuppression();
    if (data.length > 0) this.options.onData(data);
    this.input.value = "";
  };

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
      this.compositionSuppressionTimer = null;
    }
    this.compositionInputToSuppress = null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.focus();
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = ghosttyMouseButton(event.button);
      if (button === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.clearHoveredLink("default");
      this.mouseReportingPointerId = event.pointerId;
      this.mouseReportingButton = button;
      this.sendMouse("press", button, event);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (isTerminalLinkPointerGesture(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    this.clearHoveredLink();
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionMoved = false;
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event,
    );
    const clickCount = this.selectionClickSequence.count;
    this.selectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "cell";
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    if (range) {
      this.selectionBase = range.screen;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
      this.options.onSelectionChange();
    } else {
      this.selectionMode = "cell";
      this.selectionBase = null;
      this.selectionEnd = cell;
      const screen = this.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionAnchorScreen = screen;
      this.selectionEndScreen = screen;
      if (screen) {
        this.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
      } else {
        this.core.setSelection(cell, cell);
      }
    }
    this.forceFullRender = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.requestRender();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.linkActivationPointerId === event.pointerId) return;
    // Hover motion is only reportable in any-event tracking (DEC 1003); normal and
    // button-event tracking never report motion without a captured pressed button.
    const anyEventTracking = this.synchronizeMouseTrackingState();
    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(anyEventTracking, event)
    ) {
      event.preventDefault();
      this.hoverPointer = { x: event.clientX, y: event.clientY };
      this.linkModifierActive = isTerminalLinkPointerGesture(event);
      // A drag whose press was already sent to the terminal application cannot
      // turn into link activation midway through, so link feedback would lie.
      this.setHoveredLink(null);
      this.canvas.style.cursor = "default";
      this.sendMouse("motion", this.buttonFromButtons(event.buttons), event);
      return;
    }
    this.lastMouseMotionData = "";
    if (!this.selectionAnchorScreen || !this.canvas.hasPointerCapture(event.pointerId)) {
      this.updateHoverCursor(event);
      return;
    }
    this.clearHoveredLink();
    this.selectionPointer = { x: event.clientX, y: event.clientY };
    const bounds = this.canvas.getBoundingClientRect();
    this.setSelectionAutoscroll(
      event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0,
    );
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.extendSelectionTo(event.clientX, event.clientY);
  };

  private extendSelectionTo(clientX: number, clientY: number): void {
    const anchorScreen = this.selectionAnchorScreen;
    if (anchorScreen === null) return;
    const cell = this.cellAt(clientX, clientY);
    this.selectionMoved = true;
    this.selectionEnd = cell;
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    const cellScreen = this.core.viewportPointToScreen(cell.x, cell.y);
    if (cellScreen === null) return;
    const base = this.selectionBase;
    const beforeBase =
      base !== null &&
      (cellScreen.y < base.start.y ||
        (cellScreen.y === base.start.y && cellScreen.x < base.start.x));
    const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start;
    const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end;
    this.selectionAnchorScreen = anchor;
    this.selectionEndScreen = end;
    this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 });
    this.options.onSelectionChange();
    this.forceFullRender = true;
    this.requestRender();
  }

  private setSelectionAutoscroll(delta: number): void {
    this.selectionScrollDelta = delta;
    if (delta === 0) {
      if (this.selectionScrollTimer !== null) {
        window.clearInterval(this.selectionScrollTimer);
        this.selectionScrollTimer = null;
      }
      return;
    }
    if (this.selectionScrollTimer !== null) return;
    // Dragging past the edge scrolls the viewport and keeps extending the
    // selection into the newly revealed rows, like xterm's drag scroller.
    this.selectionScrollTimer = window.setInterval(() => {
      if (this.disposed || this.selectionScrollDelta === 0) return;
      this.scrollViewport(this.selectionScrollDelta);
      const pointer = this.selectionPointer;
      if (pointer) this.extendSelectionTo(pointer.x, pointer.y);
    }, 80);
  }

  private updateHoverCursor(event: PointerEvent): void {
    this.hoverPointer = { x: event.clientX, y: event.clientY };
    this.linkModifierActive = isTerminalLinkPointerGesture(event);
    this.refreshHoveredLink();
  }

  private updateLinkModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): void {
    const active = isTerminalLinkPointerGesture(event);
    if (active === this.linkModifierActive) return;
    this.linkModifierActive = active;
    this.refreshHoveredLink();
  }

  private readonly onPointerLeave = () => {
    this.lastMouseMotionData = "";
    this.clearHoveredLink();
  };

  private clearHoveredLink(cursor = ""): void {
    this.hoverPointer = null;
    this.setHoveredLink(null);
    this.canvas.style.cursor = cursor;
  }

  private refreshHoveredLink(): void {
    const pointer = this.hoverPointer;
    const link = pointer && this.linkModifierActive ? this.linkAt(pointer.x, pointer.y) : null;
    this.setHoveredLink(link);
  }

  private setHoveredLink(link: TerminalLinkWithRange | null): void {
    const previous = this.hoveredLink;
    const unchanged =
      previous?.text === link?.text &&
      previous?.range.start.x === link?.range.start.x &&
      previous?.range.start.y === link?.range.start.y &&
      previous?.range.end.x === link?.range.end.x &&
      previous?.range.end.y === link?.range.end.y;
    this.canvas.style.cursor = link ? "pointer" : "";
    if (unchanged) return;
    this.hoveredLink = link;
    this.forceFullRender = true;
    this.requestRender();
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    this.setSelectionAutoscroll(0);
    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type !== "pointercancel") {
        const link = this.linkAt(event.clientX, event.clientY);
        if (link) this.options.onLinkActivate(link.text, event);
      }
      return;
    }
    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.sendMouse("release", this.mouseReportingButton, event);
      this.mouseReportingPointerId = null;
      this.mouseReportingButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type === "pointercancel") {
        this.clearHoveredLink();
      } else {
        this.hoverPointer = { x: event.clientX, y: event.clientY };
        this.linkModifierActive = isTerminalLinkPointerGesture(event);
        this.refreshHoveredLink();
      }
      return;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.button !== 0) return;
    if (!this.selectionMoved && this.selectionMode === "cell") {
      this.clearSelection();
    }
    this.options.onSelectionChange();
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const delta = terminalWheelDeltaRows(
      event,
      this.metrics.height,
      this.rows,
      this.wheelRemainder,
    );
    this.wheelRemainder = delta.remainder;
    if (delta.rows === 0) return;
    const magnitude = Math.abs(delta.rows);
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = delta.rows < 0 ? 4 : 5;
      for (let index = 0; index < magnitude; index += 1) {
        this.sendMouse("press", button, event);
      }
      return;
    }
    if (this.core.isAlternateScreen()) {
      // The alternate screen has no scrollback: translate wheel motion into
      // arrow keys so full-screen apps like vim and less scroll, matching xterm.
      this.options.onData(terminalWheelArrowData(delta.rows, this.core.isApplicationCursorKeys()));
      return;
    }
    this.scrollViewport(delta.rows);
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
    this.focus();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      event.preventDefault();
      return;
    }
    this.options.onContextMenu?.(event);
  };

  private readonly onScrollbarPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const state = this.readScrollbarState();
    if (state === null) return;
    const bounds = this.scrollbar.getBoundingClientRect();
    const geometry = terminalScrollbarGeometry(state, bounds.height);
    if (geometry === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarPointerId = event.pointerId;
    this.scrollbarPointerOffset =
      event.target === this.scrollbarThumb
        ? event.clientY - bounds.top - geometry.thumbTop
        : geometry.thumbHeight / 2;
    this.scrollbar.setPointerCapture(event.pointerId);
    this.scrollbarToPointer(event.clientY, bounds);
  };

  private readonly onScrollbarPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarState === null) return;
    event.preventDefault();
    this.scrollbarToPointer(event.clientY, this.scrollbar.getBoundingClientRect());
  };

  private readonly onScrollbarPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId) return;
    event.preventDefault();
    this.scrollbarPointerId = null;
    if (this.scrollbar.hasPointerCapture(event.pointerId)) {
      this.scrollbar.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onScrollbarKeyDown = (event: KeyboardEvent) => {
    const state = this.readScrollbarState();
    if (state === null) return;
    let delta = 0;
    switch (event.key) {
      case "ArrowUp":
        delta = -1;
        break;
      case "ArrowDown":
        delta = 1;
        break;
      case "PageUp":
        delta = -Math.max(1, state.len);
        break;
      case "PageDown":
        delta = Math.max(1, state.len);
        break;
      case "Home":
        delta = -state.offset;
        break;
      case "End":
        delta = state.total - state.len - state.offset;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.scrollViewport(delta);
  };

  private installEvents(): void {
    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("keyup", this.onKeyUp);
    this.input.addEventListener("focus", this.onFocus);
    this.input.addEventListener("blur", this.onBlur);
    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("paste", this.onPaste);
    this.input.addEventListener("copy", this.onCopyEvent);
    this.input.addEventListener("compositionstart", this.onCompositionStart);
    this.input.addEventListener("compositionend", this.onCompositionEnd);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.scrollbar.addEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.addEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.addEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("keydown", this.onScrollbarKeyDown);
  }

  private removeEvents(): void {
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("keyup", this.onKeyUp);
    this.input.removeEventListener("focus", this.onFocus);
    this.input.removeEventListener("blur", this.onBlur);
    this.input.removeEventListener("input", this.onInput);
    this.input.removeEventListener("paste", this.onPaste);
    this.input.removeEventListener("copy", this.onCopyEvent);
    this.input.removeEventListener("compositionstart", this.onCompositionStart);
    this.input.removeEventListener("compositionend", this.onCompositionEnd);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.scrollbar.removeEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.removeEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.removeEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("keydown", this.onScrollbarKeyDown);
  }

  private scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows);
    const state = this.readScrollbarState();
    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len);
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
      delta = offset - state.offset;
      this.scrollbarState = { ...state, offset };
    }
    if (delta === 0) return;
    this.core.scroll(delta);
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  private scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    const state = this.scrollbarState;
    if (state === null) return;
    const offset = terminalScrollbarOffsetAtPointer(
      state,
      bounds.height,
      clientY - bounds.top,
      this.scrollbarPointerOffset,
    );
    this.scrollViewport(offset - state.offset);
  }

  private updateScrollbar(): void {
    const state = this.readScrollbarState();
    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, this.mount.clientHeight - CONTENT_PADDING * 2),
          );
    this.scrollbar.hidden = geometry === null;
    if (state === null || geometry === null) return;
    this.scrollbar.setAttribute("aria-valuemin", "0");
    this.scrollbar.setAttribute("aria-valuemax", String(geometry.maxOffset));
    this.scrollbar.setAttribute(
      "aria-valuenow",
      String(Math.max(0, Math.min(state.offset, geometry.maxOffset))),
    );
    this.scrollbarThumb.style.height = `${geometry.thumbHeight}px`;
    this.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`;
  }

  private readScrollbarState(): GhosttyScrollbar | null {
    const state = this.core.scrollbarState();
    this.scrollbarState = state;
    return state;
  }

  private requestRender(): void {
    if (this.disposed || this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    if (this.disposed) return;
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.snapshot = this.core.snapshot();
    // A cursor that is not blinking right now must be drawn, never caught in an
    // off phase left behind by a blink that has since been turned off.
    if (!this.blinkEnabled()) this.cursorOn = true;
    // The origin only moves together with a forced full repaint: partial
    // dirty-row redraws must never composite rows at a shifted origin over
    // rows painted at the previous one. Bottom anchoring starts once
    // scrollback exists, i.e. when the prompt actually lives at the bottom.
    const scrollState = this.readScrollbarState();
    const anchorBottom = scrollState !== null && scrollState.total > scrollState.len;
    const nextOriginY = terminalContentOriginY(
      this.mountHeight,
      CONTENT_PADDING,
      this.rows,
      this.metrics.height,
      anchorBottom,
    );
    if (nextOriginY !== this.originY) {
      this.originY = nextOriginY;
      this.forceFullRender = true;
    }
    this.refreshHoveredLink();
    renderGhosttySnapshot({
      context: this.context,
      snapshot: this.snapshot,
      metrics: this.metrics,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      padding: CONTENT_PADDING,
      originY: this.originY,
      forceFull: this.forceFullRender,
      cursorOn: this.cursorOn,
      previousCursorY: this.renderedCursorY,
      focused: this.focused,
      hoveredLinkRange: this.hoveredLink?.range ?? null,
      ...(this.theme.selectionBackground !== undefined
        ? { selectionBackground: this.theme.selectionBackground }
        : {}),
    });
    this.positionInput();
    this.renderedCursorY =
      this.cursorOn && this.snapshot.cursorVisible && this.snapshot.cursorY >= 0
        ? this.snapshot.cursorY
        : null;
    if (this.scrollbarDirty) {
      this.scrollbarDirty = false;
      this.updateScrollbar();
    }
    this.forceFullRender = false;
    this.scheduleCursorBlink();
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    if (!this.blinkEnabled()) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorOn = !this.cursorOn;
      this.requestRender();
    }, CURSOR_BLINK_INTERVAL_MS);
  }

  private blinkEnabled(): boolean {
    const snapshot = this.snapshot;
    if (!snapshot) return false;
    return shouldBlinkTerminalCursor({
      focused: this.focused,
      cursorBlinking: snapshot.cursorBlinking,
      cursorVisible: snapshot.cursorVisible,
      reducedMotion: this.reducedMotionMedia?.matches ?? false,
    });
  }

  private positionInput(): void {
    const snapshot = this.snapshot;
    if (!snapshot || !snapshot.cursorVisible || snapshot.cursorX < 0 || snapshot.cursorY < 0) {
      return;
    }
    // The IME candidate window anchors to the textarea, so it must follow the
    // terminal cursor for composition to appear where the user is typing.
    const left = CONTENT_PADDING + snapshot.cursorX * this.metrics.width;
    const top = this.originY + snapshot.cursorY * this.metrics.height;
    if (left === this.inputLeft && top === this.inputTop) return;
    this.inputLeft = left;
    this.inputTop = top;
    this.input.style.left = `${left}px`;
    this.input.style.top = `${top}px`;
    this.input.style.height = `${this.metrics.height}px`;
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          this.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.metrics.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.rows - 1,
          Math.floor((clientY - bounds.top - this.originY) / this.metrics.height),
        ),
      ),
    };
  }

  private linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    if (!this.snapshot) return null;
    const cell = terminalGridCellAt({
      bounds: this.canvas.getBoundingClientRect(),
      clientX,
      clientY,
      cols: this.cols,
      rows: this.rows,
      metrics: this.metrics,
      padding: CONTENT_PADDING,
      originY: this.originY,
    });
    if (!cell) return null;
    const explicitHyperlink = this.core.hyperlinkAt(cell.x, cell.y);
    if (explicitHyperlink) {
      const start = { ...cell };
      const end = { ...cell };
      while (true) {
        const previous =
          start.x > 0
            ? { x: start.x - 1, y: start.y }
            : start.y > 0 && this.snapshot.rowData[start.y]?.isWrapContinuation
              ? { x: this.cols - 1, y: start.y - 1 }
              : null;
        if (!previous || this.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink) break;
        start.x = previous.x;
        start.y = previous.y;
      }
      while (true) {
        const next =
          end.x + 1 < this.cols
            ? { x: end.x + 1, y: end.y }
            : end.y + 1 < this.rows && this.snapshot.rowData[end.y]?.wrapsToNext
              ? { x: 0, y: end.y + 1 }
              : null;
        if (!next || this.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break;
        end.x = next.x;
        end.y = next.y;
      }
      return {
        text: explicitHyperlink,
        range: { start, end },
      };
    }
    return terminalLinkAtPositionWithRange(this.snapshot.rowData, cell.y, cell.x);
  }

  private sendMouse(action: TerminalMouseAction, button: number | null, event: MouseEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    const data = this.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
      paddingLeft: CONTENT_PADDING,
      paddingRight: CONTENT_PADDING,
      paddingTop: this.originY,
      paddingBottom: Math.max(0, bounds.height - this.originY - this.rows * this.metrics.height),
      anyButtonPressed: event.buttons !== 0,
    });
    const resolution = resolveTerminalMouseData(action, data, this.lastMouseMotionData);
    this.lastMouseMotionData = resolution.nextMotionData;
    if (resolution.send) this.options.onData(data);
  }

  private synchronizeMouseTrackingState(): boolean {
    // Output writes can toggle DEC 1003 without moving the pointer. Keep the
    // previous mode so the next same-cell motion starts a fresh tracking session.
    const tracking = this.core.isMouseAnyEventTracking();
    const state = resolveTerminalMouseTrackingState(
      this.mouseAnyEventTracking,
      tracking,
      this.lastMouseMotionData,
    );
    this.mouseAnyEventTracking = state.tracking;
    this.lastMouseMotionData = state.motionData;
    return tracking;
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1;
    if ((buttons & 4) !== 0) return 3;
    if ((buttons & 2) !== 0) return 2;
    if ((buttons & 8) !== 0) return 4;
    if ((buttons & 16) !== 0) return 5;
    return null;
  }
}
