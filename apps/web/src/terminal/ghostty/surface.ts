import {
  GhosttyTerminalCore,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "./core";
import { measureGhosttyCell, terminalGridSize, type GhosttyCellMetrics } from "./renderer";
import { observeResize } from "../../lib/observeResize";
import {
  GhosttyTerminalFont,
  ensureTerminalSymbolsFont,
  loadTerminalFontFamily,
  terminalFontFamily,
  terminalFontSize,
} from "./surfaceFonts";
import {
  CONTENT_PADDING,
  TerminalLinkWithRange,
  TerminalSelectionClickSequence,
} from "./surfaceGeometry";
import { TerminalMouseAction } from "./surfaceInput";
import {
  surfaceClearCompositionInputSuppression,
  surfaceClearPrimedCopy,
  surfaceOnBlur,
  surfaceOnCompositionEnd,
  surfaceOnCompositionStart,
  surfaceOnCopyEvent,
  surfaceOnFocus,
  surfaceOnInput,
  surfaceOnKeyDown,
  surfaceOnKeyUp,
  surfaceOnPaste,
  surfaceOnWindowKeyDown,
  surfaceOnWindowKeyUp,
  surfacePrimeCopy,
} from "./surfaceKeyboard";
import {
  surfaceBeginSelection,
  surfaceClearHoveredLink,
  surfaceExtendSelectionTo,
  surfaceOnPointerDown,
  surfaceOnPointerLeave,
  surfaceOnPointerMove,
  surfaceOnPointerUp,
  surfaceRecordSelectionClick,
  surfaceRefreshHoveredLink,
  surfaceSetHoveredLink,
  surfaceSetSelectionAutoscroll,
  surfaceUpdateHoverCursor,
} from "./surfacePointer";
import {
  surfaceOnScrollbarKeyDown,
  surfaceOnScrollbarPointerDown,
  surfaceOnScrollbarPointerMove,
  surfaceOnScrollbarPointerUp,
  surfaceReadScrollbarState,
  surfaceScrollViewport,
  surfaceScrollbarToPointer,
  surfaceUpdateScrollbar,
} from "./surfaceScrollbar";
import {
  surfaceBlinkEnabled,
  surfaceCancelRender,
  surfaceCancelSynchronizedRenderTimer,
  surfaceDeferSynchronizedRender,
  surfacePositionInput,
  surfaceRenderFrame,
  surfaceRequestRender,
  surfaceScheduleCursorBlink,
} from "./surfaceRender";
import {
  surfaceButtonFromButtons,
  surfaceCellAt,
  surfaceFindLinkAt,
  surfaceLinkAt,
  surfaceOnContextMenu,
  surfaceOnMouseDown,
  surfaceOnMouseUp,
  surfaceOnWheel,
  surfaceScrollRows,
  surfaceSendMouse,
  surfaceSynchronizeMouseTrackingState,
} from "./surfaceMouse";
import {
  surfaceClearSelection,
  surfaceGetSelection,
  surfaceGetSelectionCellCount,
  surfaceGetSelectionEndClientRect,
  surfaceGetSelectionPosition,
  surfaceHasSelection,
  surfaceSelectAll,
} from "./surfaceSelection";
import { surfaceInstallEvents, surfaceRemoveEvents } from "./surfaceEvents";

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  /** Read after font and WASM loading. */
  readonly visible?: boolean;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  readonly canActivateLink?: (text: string) => boolean;
  /** The host must prevent the default menu; native Paste cannot reach a canvas terminal. */
  readonly onContextMenu?: (event: MouseEvent) => void;
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  /** The drawn grid: the shared PTY grid, clamped per axis to the measured one. */
  cols = 1;
  rows = 1;

  readonly mount: HTMLElement;
  measuredCols = 1;
  measuredRows = 1;
  sharedGrid: { readonly cols: number; readonly rows: number } | null = null;
  readonly context: CanvasRenderingContext2D;
  readonly core: GhosttyTerminalCore;
  readonly options: GhosttyTerminalSurfaceOptions;
  visible: boolean;
  hasSize = false;
  metrics: GhosttyCellMetrics;
  fontFamily: string;
  requestedFontFamily: string | undefined;
  fontSize: number;
  fontEpoch = 0;
  pendingFontEpoch: number | null = null;
  readonly stopObservingResize: () => void;
  readonly scrollbarThumb: HTMLDivElement;
  snapshot: GhosttySnapshot | null = null;
  frame = 0;
  synchronizedRenderTimer: number | null = null;
  cursorTimer: number | null = null;
  compositionInputToSuppress: string | null = null;
  compositionSuppressionTimer: number | null = null;
  cursorOn = true;
  renderedCursorY: number | null = null;
  forceFullRender = true;
  scrollbarDirty = true;
  scrollbarState: GhosttyScrollbar | null = null;
  scrollbarPointerId: number | null = null;
  scrollbarPointerOffset = 0;
  disposed = false;
  resizeNotifyTimer: number | null = null;
  originY = CONTENT_PADDING;
  mountHeight = 0;
  selectionEnd: { x: number; y: number } | null = null;
  selectionAnchorScreen: { x: number; y: number } | null = null;
  selectionMode: "cell" | "word" | "line" = "cell";
  selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  selectionScrollTimer: number | null = null;
  selectionScrollDelta = 0;
  selectionPointer: { x: number; y: number } | null = null;
  mouseReportingPointerId: number | null = null;
  mouseReportingButton: number | null = null;
  linkActivationPointerId: number | null = null;
  linkActivationLink: TerminalLinkWithRange | null = null;
  linkActivationOrigin: {
    x: number;
    y: number;
    clickCount: number;
  } | null = null;
  hoveredLink: TerminalLinkWithRange | null = null;
  hoverPointer: { x: number; y: number } | null = null;
  selectionClickSequence: TerminalSelectionClickSequence | null = null;
  selectionMoved = false;
  composing = false;
  focused = false;
  resizeNotified = false;
  canvasConfigured = false;
  canvasDevicePixelRatio = 0;
  pendingCanvasConfiguration: {
    readonly width: number;
    readonly height: number;
    readonly ratio: number;
  } | null = null;
  theme: GhosttyTheme;
  // App capture can hide keydowns, so only encoded presses qualify for Kitty releases.
  readonly encodedKeyCodes = new Set<string>();
  pasteShortcutToken = 0;
  // Chromium can deliver native paste after the clipboard read resolves.
  // Suppress its duplicate only for the current shortcut gesture.
  pasteShortcutGesture: { code: string; readText: string } | null = null;
  copyShortcutToken = 0;
  clearSelectionAfterCopy = false;
  primedCopySelection = "";
  wheelRemainder = 0;
  touchScroll: {
    pointerId: number;
    startX: number;
    startY: number;
    lastY: number;
    remainder: number;
    moved: boolean;
  } | null = null;
  lastMouseMotionData = "";
  mouseAnyEventTracking = false;
  dprMedia: MediaQueryList | null = null;
  // Watch reduced motion changes to restart blink cycles that have no remaining timer.
  readonly reducedMotionMedia = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  inputLeft = -1;
  inputTop = -1;

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
    this.visible = options.visible ?? true;
    this.theme = options.theme;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = options.font?.family;
    this.fontSize = terminalFontSize(options.font?.size);
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener("change", this.onReducedMotionChange);
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
    this.stopObservingResize = observeResize(mount, () => this.fit());
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    const canvas = document.createElement("canvas");
    canvas.className = "block size-full cursor-text";
    canvas.style.touchAction = "pan-x pinch-zoom";
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
    context.fillStyle = `rgb(${options.theme.background.r}, ${options.theme.background.g}, ${options.theme.background.b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = terminalFontSize(options.font?.size);
    try {
      // Load bundled fonts before measuring; fallback metrics would size the wrong grid.
      await ensureTerminalSymbolsFont();
    } catch {}
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
    return surface;
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    if (!visible) {
      this.cancelRender();
      this.setSelectionAutoscroll(0);
      return;
    }
    this.fit();
  }

  write(data: string): void {
    if (this.disposed) return;
    this.core.write(
      data,
      this.synchronizedRenderTimer === null
        ? undefined
        : () => this.cancelSynchronizedRenderTimer(),
    );
    this.synchronizeMouseTrackingState();
    this.cursorOn = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  resetAndWrite(data: string): void {
    if (this.disposed) return;
    this.cancelSynchronizedRenderTimer();
    this.lastMouseMotionData = "";
    this.core.resetAndWrite(data);
    this.synchronizeMouseTrackingState();
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

  refreshLinkActivation(): void {
    if (this.disposed) return;
    this.refreshHoveredLink();
  }

  /** Mount height, in CSS pixels, that shows exactly `rows` rows at the current font. */
  heightForRows(rows: number): number {
    return Math.ceil(rows * this.metrics.height + CONTENT_PADDING * 2);
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return;
    const fontSize = terminalFontSize(font.size);
    // Commit fields with loaded metrics; the epoch makes the newest overlapping call win.
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

  applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
    this.inputLeft = -1;
    this.inputTop = -1;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.fit();
    this.requestRender();
  }

  readonly onReducedMotionChange = () => {
    if (this.disposed) return;
    // Restart from render; reduced motion left the steady cursor with no blink timer.
    this.cursorOn = true;
    this.requestRender();
  };

  readonly onFontsLoaded = () => {
    if (this.disposed) return;
    // Explicit loads validate and apply the newest request; ignore their events for the old face.
    if (this.pendingFontEpoch !== null) return;
    const fontFamily = terminalFontFamily(this.requestedFontFamily);
    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.applyFontMetrics();
      return;
    }
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

  resendSize(): void {
    this.resizeNotified = false;
    this.fit();
  }

  fit(): boolean {
    if (this.disposed || !this.visible) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (width <= 0 || height <= 0) {
      this.hasSize = false;
      this.forceFullRender = true;
      this.cancelRender();
      return false;
    }
    this.hasSize = true;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    let shouldRender = false;
    // First fit must install DPR even if backing size matches the canvas default.
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured ||
      this.canvasDevicePixelRatio !== ratio
    ) {
      // A backing-size change clears the canvas. Apply it with the gated paint
      // so a DPR change cannot erase a frame while synchronized output is open.
      this.pendingCanvasConfiguration = { width: pixelWidth, height: pixelHeight, ratio };
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    } else {
      // A resize can return to the painted size before its queued frame runs.
      this.pendingCanvasConfiguration = null;
    }
    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING);
    this.mountHeight = height;
    // onResize is the only PTY resize channel, so the first successful fit must
    // notify even when the measured grid equals the 1x1 construction sentinel.
    if (
      grid.cols !== this.measuredCols ||
      grid.rows !== this.measuredRows ||
      !this.resizeNotified
    ) {
      this.measuredCols = grid.cols;
      this.measuredRows = grid.rows;
      this.notifyResize();
    }
    if (this.applyGrid()) shouldRender = true;
    // Repaint synchronously before paint so resize never stretches the old backing store.
    if (shouldRender || this.forceFullRender) this.renderFrame();
    return true;
  }

  /**
   * Other clients can share this PTY, so the server owns its grid. Drawing that grid
   * keeps wrapping and cursor positions in step with the PTY. Each axis is clamped to
   * this surface's own fit: the server's grid lags a local resize, and read-only
   * observers never constrain it.
   */
  setSharedGrid(grid: { readonly cols: number; readonly rows: number } | null): void {
    if (this.disposed) return;
    if (this.sharedGrid?.cols === grid?.cols && this.sharedGrid?.rows === grid?.rows) return;
    this.sharedGrid = grid;
    if (this.hasSize && this.applyGrid()) this.requestRender();
  }

  applyGrid(): boolean {
    const cols = Math.min(this.sharedGrid?.cols ?? this.measuredCols, this.measuredCols);
    const rows = Math.min(this.sharedGrid?.rows ?? this.measuredRows, this.measuredRows);
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    this.core.resize(cols, rows, this.metrics.width, this.metrics.height);
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    return true;
  }

  /**
   * The local grid reflows immediately, but the PTY only hears about settled
   * dimensions: notifying on every drag step makes the shell reprint its
   * prompt mid-drag, which reads as jitter.
   */
  notifyResize(): void {
    this.resizeNotified = true;
    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null;
      if (!this.disposed) this.options.onResize(this.measuredCols, this.measuredRows);
    }, 150);
  }

  // Flush on release so immediate typing reaches a shell with the settled width.
  readonly onWindowPointerRelease = () => {
    if (this.disposed || this.resizeNotifyTimer === null) return;
    this.fit();
    if (this.resizeNotifyTimer === null) return;
    window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = null;
    this.options.onResize(this.measuredCols, this.measuredRows);
  };

  focus(): void {
    if (this.disposed || !this.visible) return;
    this.input.focus({ preventScroll: true });
  }

  /** Claims before reading; later shortcut or native pastes supersede the pending read. */
  async pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const token = ++this.pasteShortcutToken;
    const text = await readText();
    if (this.disposed || this.pasteShortcutToken !== token || !isCurrent()) return;
    this.pasteShortcutToken += 1;
    if (text.length === 0) return;
    const encoded = this.core.encodePaste(text);
    if (encoded.length > 0) this.options.onData(encoded);
  }

  // The terminal selection is the only browser-readable PRIMARY-like buffer.
  pasteTerminalSelection(): void {
    const selection = this.getSelection();
    if (selection.length === 0) return;
    void this.pasteFromClipboard(() => Promise.resolve(selection));
  }

  hasSelection(): boolean {
    return surfaceHasSelection(this);
  }

  getSelection(): string {
    return surfaceGetSelection(this);
  }

  getSelectionCellCount(): number {
    return surfaceGetSelectionCellCount(this);
  }

  selectAll(): void {
    surfaceSelectAll(this);
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    return surfaceGetSelectionPosition(this);
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    return surfaceGetSelectionEndClientRect(this);
  }

  clearSelection(): void {
    surfaceClearSelection(this);
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
    this.stopObservingResize();
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    this.dprMedia = null;
    this.reducedMotionMedia?.removeEventListener("change", this.onReducedMotionChange);
    if (this.selectionScrollTimer !== null) window.clearInterval(this.selectionScrollTimer);
    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer);
      this.resizeNotifyTimer = null;
      this.options.onResize(this.measuredCols, this.measuredRows);
    }
    this.cancelRender();
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

  onKeyDown = (event: KeyboardEvent) => surfaceOnKeyDown(this, event);

  onKeyUp = (event: KeyboardEvent) => surfaceOnKeyUp(this, event);

  onWindowKeyUp = (event: KeyboardEvent) => surfaceOnWindowKeyUp(this, event);

  onWindowKeyDown = (event: KeyboardEvent) => surfaceOnWindowKeyDown(this, event);

  onFocus = () => surfaceOnFocus(this);

  onBlur = () => surfaceOnBlur(this);

  readonly onDevicePixelRatioChange = () => {
    this.watchDevicePixelRatio();
    this.fit();
  };

  watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    // Resolution queries track only their initial ratio; re-arm after every change.
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener("change", this.onDevicePixelRatioChange);
  }

  primeCopy(selection: string): void {
    surfacePrimeCopy(this, selection);
  }

  clearPrimedCopy(): void {
    surfaceClearPrimedCopy(this);
  }

  onCopyEvent = (event: ClipboardEvent) => surfaceOnCopyEvent(this, event);

  onPaste = (event: ClipboardEvent) => surfaceOnPaste(this, event);

  onCompositionStart = () => surfaceOnCompositionStart(this);

  onCompositionEnd = (event: CompositionEvent) => surfaceOnCompositionEnd(this, event);

  onInput = (event: Event) => surfaceOnInput(this, event);

  clearCompositionInputSuppression(): void {
    surfaceClearCompositionInputSuppression(this);
  }

  onPointerDown = (event: PointerEvent) => surfaceOnPointerDown(this, event);

  recordSelectionClick(event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">): number {
    return surfaceRecordSelectionClick(this, event);
  }

  beginSelection(event: { clientX: number; clientY: number }, clickCount: number): void {
    surfaceBeginSelection(this, event, clickCount);
  }

  onPointerMove = (event: PointerEvent) => surfaceOnPointerMove(this, event);

  extendSelectionTo(clientX: number, clientY: number): void {
    surfaceExtendSelectionTo(this, clientX, clientY);
  }

  setSelectionAutoscroll(delta: number): void {
    surfaceSetSelectionAutoscroll(this, delta);
  }

  updateHoverCursor(event: PointerEvent): void {
    surfaceUpdateHoverCursor(this, event);
  }

  onPointerLeave = () => surfaceOnPointerLeave(this);

  clearHoveredLink(cursor = ""): void {
    surfaceClearHoveredLink(this, cursor);
  }

  refreshHoveredLink(): void {
    surfaceRefreshHoveredLink(this);
  }

  setHoveredLink(link: TerminalLinkWithRange | null): void {
    surfaceSetHoveredLink(this, link);
  }

  onPointerUp = (event: PointerEvent) => surfaceOnPointerUp(this, event);

  onWheel = (event: WheelEvent) => surfaceOnWheel(this, event);

  scrollRows(rows: number, event: MouseEvent): void {
    surfaceScrollRows(this, rows, event);
  }

  onMouseDown = (event: MouseEvent) => surfaceOnMouseDown(this, event);

  // Chromium middle mouseup pastes PRIMARY into the focused textarea; prevent a second paste.
  onMouseUp = (event: MouseEvent) => surfaceOnMouseUp(this, event);

  onContextMenu = (event: MouseEvent) => surfaceOnContextMenu(this, event);

  onScrollbarPointerDown = (event: PointerEvent) => surfaceOnScrollbarPointerDown(this, event);

  onScrollbarPointerMove = (event: PointerEvent) => surfaceOnScrollbarPointerMove(this, event);

  onScrollbarPointerUp = (event: PointerEvent) => surfaceOnScrollbarPointerUp(this, event);

  onScrollbarKeyDown = (event: KeyboardEvent) => surfaceOnScrollbarKeyDown(this, event);

  installEvents(): void {
    surfaceInstallEvents(this);
  }

  removeEvents(): void {
    surfaceRemoveEvents(this);
  }

  scrollViewport(deltaRows: number): void {
    surfaceScrollViewport(this, deltaRows);
  }

  scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    surfaceScrollbarToPointer(this, clientY, bounds);
  }

  updateScrollbar(): void {
    surfaceUpdateScrollbar(this);
  }

  readScrollbarState(): GhosttyScrollbar | null {
    return surfaceReadScrollbarState(this);
  }

  requestRender(): void {
    surfaceRequestRender(this);
  }

  cancelRender(): void {
    surfaceCancelRender(this);
  }

  cancelSynchronizedRenderTimer(): void {
    surfaceCancelSynchronizedRenderTimer(this);
  }

  deferSynchronizedRender(): boolean {
    return surfaceDeferSynchronizedRender(this);
  }

  renderFrame(): void {
    surfaceRenderFrame(this);
  }

  scheduleCursorBlink(): void {
    surfaceScheduleCursorBlink(this);
  }

  blinkEnabled(): boolean {
    return surfaceBlinkEnabled(this);
  }

  positionInput(): void {
    surfacePositionInput(this);
  }

  cellAt(clientX: number, clientY: number): { x: number; y: number } {
    return surfaceCellAt(this, clientX, clientY);
  }

  linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    return surfaceLinkAt(this, clientX, clientY);
  }

  findLinkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    return surfaceFindLinkAt(this, clientX, clientY);
  }

  sendMouse(action: TerminalMouseAction, button: number | null, event: MouseEvent): void {
    surfaceSendMouse(this, action, button, event);
  }

  synchronizeMouseTrackingState(): boolean {
    return surfaceSynchronizeMouseTrackingState(this);
  }

  buttonFromButtons(buttons: number): number | null {
    return surfaceButtonFromButtons(this, buttons);
  }
}

export * from "./surfaceFonts";
export * from "./surfaceGeometry";
export * from "./surfaceInput";
export * from "./surfaceParts";
export * from "./surfaceKeyboard";
export * from "./surfacePointer";
export * from "./surfaceScrollbar";
export * from "./surfaceRender";
export * from "./surfaceMouse";
export * from "./surfaceSelection";
export * from "./surfaceEvents";
