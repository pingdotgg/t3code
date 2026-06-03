import { FitAddon } from "@xterm/addon-fit";
import { Plus, SquareSplitHorizontal, TerminalSquare, Trash2, XIcon } from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  applyTerminalCtrlModifier,
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey,
  type TerminalModifier,
} from "~/lib/terminalAccessoryKeys";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../types";
import { readEnvironmentApi } from "~/environmentApi";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { readLocalApi } from "~/localApi";
import { selectTerminalEventEntries, useTerminalStateStore } from "../terminalStateStore";
import { openPathInPreferredEditorOrFilePreview } from "../workspaceFilePreview";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const KEYBOARD_INSET_THRESHOLD = 80;
const TOUCH_SCROLL_ACTIVATION_PX = 6;
const TOUCH_LONG_PRESS_MS = 450;
// A small amount of finger drift is tolerated before a hold is treated as a
// scroll instead of a long-press.
const TOUCH_LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export interface TerminalKeyboardViewport {
  bottomInset: number;
  visibleHeight: number | null;
}

const EMPTY_TERMINAL_KEYBOARD_VIEWPORT: TerminalKeyboardViewport = Object.freeze({
  bottomInset: 0,
  visibleHeight: null,
});

function terminalKeyboardViewportEqual(
  left: TerminalKeyboardViewport,
  right: TerminalKeyboardViewport,
): boolean {
  return left.bottomInset === right.bottomInset && left.visibleHeight === right.visibleHeight;
}

export function resolveTerminalKeyboardViewport(input: {
  layoutViewportHeight: number;
  visualViewportHeight: number | null | undefined;
  visualViewportOffsetTop: number | null | undefined;
}): TerminalKeyboardViewport {
  const layoutViewportHeight = Number.isFinite(input.layoutViewportHeight)
    ? Math.max(0, input.layoutViewportHeight)
    : 0;
  const visualViewportHeight =
    typeof input.visualViewportHeight === "number" && Number.isFinite(input.visualViewportHeight)
      ? Math.max(0, input.visualViewportHeight)
      : null;
  const visualViewportOffsetTop =
    typeof input.visualViewportOffsetTop === "number" &&
    Number.isFinite(input.visualViewportOffsetTop)
      ? Math.max(0, input.visualViewportOffsetTop)
      : 0;

  if (layoutViewportHeight <= 0 || visualViewportHeight === null || visualViewportHeight <= 0) {
    return EMPTY_TERMINAL_KEYBOARD_VIEWPORT;
  }

  const bottomInset = Math.max(
    0,
    Math.ceil(layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop),
  );
  if (bottomInset < KEYBOARD_INSET_THRESHOLD) {
    return EMPTY_TERMINAL_KEYBOARD_VIEWPORT;
  }

  return {
    bottomInset,
    visibleHeight: visualViewportHeight,
  };
}

function readTerminalKeyboardViewport(): TerminalKeyboardViewport {
  if (typeof window === "undefined" || !window.visualViewport) {
    return EMPTY_TERMINAL_KEYBOARD_VIEWPORT;
  }

  return resolveTerminalKeyboardViewport({
    layoutViewportHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport.height,
    visualViewportOffsetTop: window.visualViewport.offsetTop,
  });
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

export function resolveRenderedDrawerHeight(
  drawerHeight: number,
  keyboardViewport: TerminalKeyboardViewport,
): number {
  if (keyboardViewport.bottomInset <= 0 || keyboardViewport.visibleHeight === null) {
    return drawerHeight;
  }
  const keyboardMaxHeight = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(keyboardViewport.visibleHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  return Math.min(drawerHeight, keyboardMaxHeight);
}

export function resolveTerminalTouchScroll(input: {
  accumulatedPixels: number;
  rowHeight: number;
}): { lines: number; remainingPixels: number } {
  const rowHeight = Number.isFinite(input.rowHeight) && input.rowHeight > 0 ? input.rowHeight : 1;
  const lines =
    input.accumulatedPixels < 0
      ? Math.ceil(input.accumulatedPixels / rowHeight)
      : Math.floor(input.accumulatedPixels / rowHeight);
  return {
    lines,
    remainingPixels: input.accumulatedPixels - lines * rowHeight,
  };
}

interface TerminalCell {
  column: number;
  row: number;
}

// xterm's default word separators: a double-press selects the run of
// characters bounded by these, so a long-press can select the same group.
export const TERMINAL_WORD_SEPARATORS = " ()[]{}',\"`";

function terminalCellToIndex(cell: TerminalCell, cols: number): number {
  return cell.row * cols + cell.column;
}

function terminalCellFromIndex(index: number, cols: number): TerminalCell {
  const row = Math.floor(index / cols);
  return { column: index - row * cols, row };
}

export function resolveTerminalCellFromPoint(input: {
  bounds: { left: number; top: number; width: number; height: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  viewportY: number;
}): TerminalCell | null {
  if (
    !Number.isFinite(input.bounds.width) ||
    !Number.isFinite(input.bounds.height) ||
    !(input.bounds.width > 0) ||
    !(input.bounds.height > 0) ||
    !Number.isInteger(input.cols) ||
    input.cols < 1 ||
    !Number.isInteger(input.rows) ||
    input.rows < 1
  ) {
    return null;
  }

  const colWidth = input.bounds.width / input.cols;
  const rowHeight = input.bounds.height / input.rows;
  if (!(colWidth > 0) || !(rowHeight > 0)) {
    return null;
  }

  const column = Math.min(
    Math.max(Math.floor((input.clientX - input.bounds.left) / colWidth), 0),
    input.cols - 1,
  );
  const viewportRow = Math.min(
    Math.max(Math.floor((input.clientY - input.bounds.top) / rowHeight), 0),
    input.rows - 1,
  );
  const viewportY = Number.isInteger(input.viewportY) ? Math.max(input.viewportY, 0) : 0;
  return { column, row: viewportY + viewportRow };
}

export function resolveTerminalTouchSelectionRange(input: {
  cols: number;
  currentCell: TerminalCell;
  wordEndExclusive: TerminalCell;
  wordStart: TerminalCell;
}): { column: number; row: number; length: number } | null {
  if (!Number.isInteger(input.cols) || input.cols < 1) {
    return null;
  }

  const wordStartIndex = terminalCellToIndex(input.wordStart, input.cols);
  const wordEndExclusiveIndex = terminalCellToIndex(input.wordEndExclusive, input.cols);
  const currentIndex = terminalCellToIndex(input.currentCell, input.cols);
  if (wordEndExclusiveIndex <= wordStartIndex) {
    return null;
  }

  if (currentIndex >= wordStartIndex && currentIndex < wordEndExclusiveIndex) {
    return {
      column: input.wordStart.column,
      row: input.wordStart.row,
      length: wordEndExclusiveIndex - wordStartIndex,
    };
  }

  if (currentIndex < wordStartIndex) {
    return {
      column: input.currentCell.column,
      row: input.currentCell.row,
      length: wordEndExclusiveIndex - currentIndex,
    };
  }

  return {
    column: input.wordStart.column,
    row: input.wordStart.row,
    length: currentIndex - wordStartIndex + 1,
  };
}

// Resolve the word group around `column` in a row's text using the same
// separator rules xterm applies for double-click selection. Returns null when
// the column sits on a separator or blank cell.
export function resolveTerminalWordRange(
  lineText: string,
  column: number,
  separators: string = TERMINAL_WORD_SEPARATORS,
): { start: number; length: number } | null {
  if (!Number.isInteger(column) || column < 0 || column >= lineText.length) {
    return null;
  }
  const isSeparator = (index: number): boolean => {
    const char = lineText[index];
    return char === undefined || char === " " || separators.includes(char);
  };
  if (isSeparator(column)) {
    return null;
  }
  let start = column;
  while (start > 0 && !isSeparator(start - 1)) {
    start -= 1;
  }
  let end = column;
  while (end < lineText.length - 1 && !isSeparator(end + 1)) {
    end += 1;
  }
  return { start, length: end - start + 1 };
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalSnapshot(terminal: Terminal, snapshot: TerminalSessionSnapshot): void {
  terminal.write("\u001bc");
  if (snapshot.history.length > 0) {
    terminal.write(snapshot.history);
  }
}

export function selectTerminalEventEntriesAfterSnapshot(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  snapshotUpdatedAt: string,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.event.createdAt > snapshotUpdatedAt);
}

export function selectPendingTerminalEventEntries(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

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

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
  pendingModifierRef?: MutableRefObject<TerminalModifier | null>;
  onModifierConsumed?: () => void;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  keybindings,
  pendingModifierRef,
  onModifierConsumed,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const environmentId = threadRef.environmentId;
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const keybindingsRef = useRef(keybindings);
  const onModifierConsumedRef = useRef(onModifierConsumed);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const touchScrollStateRef = useRef<{
    accumulatedPixels: number;
    active: boolean;
    lastY: number;
    startX: number;
    startY: number;
    touchId: number;
  } | null>(null);
  const touchSelectionStateRef = useRef<{
    lastPoint: { x: number; y: number };
    touchId: number;
    wordEndExclusive: TerminalCell;
    wordStart: TerminalCell;
  } | null>(null);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    onModifierConsumedRef.current = onModifierConsumed;
  }, [onModifierConsumed]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    const api = readEnvironmentApi(environmentId);
    const localApi = readLocalApi();
    if (!api || !localApi) return;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
      wordSeparator: TERMINAL_WORD_SEPARATORS,
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    const copyTextToClipboard = async (text: string) => {
      const activeTerminal = terminalRef.current;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (activeTerminal) {
          writeSystemMessage(activeTerminal, "Copy is unavailable on this device");
        }
      }
    };

    const pasteFromClipboard = async () => {
      const activeTerminal = terminalRef.current;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        if (activeTerminal) {
          writeSystemMessage(activeTerminal, "Paste is unavailable on this device");
        }
        return;
      }
      if (text.length === 0) return;
      // Paste is forwarded verbatim and must bypass the soft-keyboard Ctrl latch.
      await sendTerminalInput(text, "Failed to paste");
    };

    const buildSelectionMenuItems = (hasSelection: boolean) =>
      hasSelection
        ? [
            { id: "copy", label: "Copy" },
            { id: "paste", label: "Paste" },
            { id: "add-to-chat", label: "Add to chat" },
          ]
        : [{ id: "paste", label: "Paste" }];

    const runSelectionMenuAction = async (
      clicked: string,
      selectionAction: ReturnType<typeof readSelectionAction>,
    ) => {
      if (clicked === "copy" && selectionAction) {
        await copyTextToClipboard(selectionAction.selection.text);
        terminalRef.current?.clearSelection();
      } else if (clicked === "paste") {
        await pasteFromClipboard();
      } else if (clicked === "add-to-chat" && selectionAction) {
        handleAddTerminalContext(selectionAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      }
    };

    // Shared menu for both the double-press selection and the touch long-press.
    // When `allowEmptySelection` is set (touch), a blank target still offers
    // Paste; otherwise (mouse) the menu only appears for an active selection.
    const presentSelectionMenu = async (
      position: { x: number; y: number },
      allowEmptySelection: boolean,
    ) => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const selectionAction = readSelectionAction();
      if (!selectionAction && !allowEmptySelection) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await localApi.contextMenu.show(
          buildSelectionMenuItems(selectionAction !== null),
          position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked === null) {
          return;
        }
        await runSelectionMenuAction(clicked, selectionAction);
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    // Double-press: xterm has already selected the word group, so anchor the
    // menu to that selection.
    const showSelectionAction = async () => {
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      await presentSelectionMenu(nextAction.position, false);
    };

    const selectTouchRange = (state: NonNullable<typeof touchSelectionStateRef.current>) => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement) return false;
      const bounds = mountElement.getBoundingClientRect();
      const currentCell = resolveTerminalCellFromPoint({
        bounds,
        clientX: state.lastPoint.x,
        clientY: state.lastPoint.y,
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
        viewportY: activeTerminal.buffer.active.viewportY,
      });
      if (!currentCell) return false;
      const range = resolveTerminalTouchSelectionRange({
        cols: activeTerminal.cols,
        currentCell,
        wordEndExclusive: state.wordEndExclusive,
        wordStart: state.wordStart,
      });
      if (!range) return false;
      activeTerminal.select(range.column, range.row, range.length);
      return true;
    };

    // Long-press on text starts a touch selection. A blank target returns
    // false so the caller can preserve the paste-only menu behavior.
    const startTouchSelection = (touch: Touch): boolean => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement) return false;
      const bounds = mountElement.getBoundingClientRect();
      const cell = resolveTerminalCellFromPoint({
        bounds,
        clientX: touch.clientX,
        clientY: touch.clientY,
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
        viewportY: activeTerminal.buffer.active.viewportY,
      });
      if (!cell) return false;
      const lineText = activeTerminal.buffer.active.getLine(cell.row)?.translateToString(false);
      const wordRange = lineText ? resolveTerminalWordRange(lineText, cell.column) : null;
      if (!wordRange) {
        activeTerminal.clearSelection();
        return false;
      }
      const wordStart = { column: wordRange.start, row: cell.row };
      const wordEndExclusive = terminalCellFromIndex(
        terminalCellToIndex(wordStart, activeTerminal.cols) + wordRange.length,
        activeTerminal.cols,
      );
      touchSelectionStateRef.current = {
        lastPoint: { x: touch.clientX, y: touch.clientY },
        touchId: touch.identifier,
        wordEndExclusive,
        wordStart,
      };
      return selectTouchRange(touchSelectionStateRef.current);
    };

    const showTouchContextMenu = async (point: { x: number; y: number }) => {
      await presentSelectionMenu(point, true);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
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

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openPathInPreferredEditorOrFilePreview({
                targetPath: target,
                environmentId,
                cwd,
                displayPath: match.text,
              }).catch((error) => {
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
      let payload = data;
      if (pendingModifierRef?.current === "ctrl") {
        pendingModifierRef.current = null;
        onModifierConsumedRef.current?.();
        payload = applyTerminalCtrlModifier(data) ?? data;
      }
      void api.terminal
        .write({ threadId, terminalId, data: payload })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    let longPressTimer: number | null = null;
    let longPressFired = false;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      cancelLongPress();
      longPressFired = false;
      touchSelectionStateRef.current = null;
      if (event.touches.length !== 1) {
        touchScrollStateRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        touchScrollStateRef.current = null;
        return;
      }
      touchScrollStateRef.current = {
        accumulatedPixels: 0,
        active: false,
        lastY: touch.clientY,
        startX: touch.clientX,
        startY: touch.clientY,
        touchId: touch.identifier,
      };
      const point = { x: touch.clientX, y: touch.clientY };
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        // The hold became a press, not a scroll: abandon any scroll gesture.
        // Text targets enter drag-selection mode; blank targets keep the
        // paste-only menu in place.
        touchScrollStateRef.current = null;
        if (!startTouchSelection(touch)) {
          void showTouchContextMenu(point);
        }
      }, TOUCH_LONG_PRESS_MS);
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touchSelectionState = touchSelectionStateRef.current;
      if (touchSelectionState) {
        const touch = Array.from(event.changedTouches).find(
          (changedTouch) => changedTouch.identifier === touchSelectionState.touchId,
        );
        if (!touch) {
          return;
        }
        event.preventDefault();
        touchSelectionState.lastPoint = { x: touch.clientX, y: touch.clientY };
        selectTouchRange(touchSelectionState);
        return;
      }

      if (longPressFired) {
        return;
      }
      const scrollState = touchScrollStateRef.current;
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!scrollState || !activeTerminal || !mountElement) {
        return;
      }

      const touch = Array.from(event.changedTouches).find(
        (changedTouch) => changedTouch.identifier === scrollState.touchId,
      );
      if (!touch) {
        return;
      }

      const totalX = touch.clientX - scrollState.startX;
      const totalY = touch.clientY - scrollState.startY;
      if (
        longPressTimer !== null &&
        Math.hypot(totalX, totalY) > TOUCH_LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        cancelLongPress();
      }
      if (!scrollState.active) {
        if (Math.abs(totalY) < TOUCH_SCROLL_ACTIVATION_PX) {
          return;
        }
        if (Math.abs(totalX) > Math.abs(totalY)) {
          touchScrollStateRef.current = null;
          return;
        }
        scrollState.active = true;
      }

      event.preventDefault();
      const deltaPixels = scrollState.lastY - touch.clientY;
      scrollState.lastY = touch.clientY;
      scrollState.accumulatedPixels += deltaPixels;
      const rowHeight = mountElement.clientHeight / Math.max(activeTerminal.rows, 1);
      const resolved = resolveTerminalTouchScroll({
        accumulatedPixels: scrollState.accumulatedPixels,
        rowHeight,
      });
      scrollState.accumulatedPixels = resolved.remainingPixels;
      if (resolved.lines !== 0) {
        clearSelectionAction();
        activeTerminal.scrollLines(resolved.lines);
      }
    };
    const handleTouchEnd = (event: TouchEvent) => {
      cancelLongPress();
      const touchSelectionState = touchSelectionStateRef.current;
      if (touchSelectionState) {
        const hasSelectionTouch = Array.from(event.touches).some(
          (touch) => touch.identifier === touchSelectionState.touchId,
        );
        if (!hasSelectionTouch) {
          const releasedTouch = Array.from(event.changedTouches).find(
            (touch) => touch.identifier === touchSelectionState.touchId,
          );
          const point =
            releasedTouch === undefined
              ? touchSelectionState.lastPoint
              : { x: releasedTouch.clientX, y: releasedTouch.clientY };
          touchSelectionStateRef.current = null;
          selectionPointerRef.current = point;
          window.requestAnimationFrame(() => {
            void showSelectionAction();
          });
        }
        return;
      }

      const scrollState = touchScrollStateRef.current;
      if (!scrollState) {
        return;
      }
      const hasTouch = Array.from(event.touches).some(
        (touch) => touch.identifier === scrollState.touchId,
      );
      if (!hasTouch) {
        touchScrollStateRef.current = null;
      }
    };
    const handleTouchCancel = (event: TouchEvent) => {
      cancelLongPress();
      const touchSelectionState = touchSelectionStateRef.current;
      if (
        touchSelectionState &&
        Array.from(event.changedTouches).some(
          (touch) => touch.identifier === touchSelectionState.touchId,
        )
      ) {
        touchSelectionStateRef.current = null;
      }
      const scrollState = touchScrollStateRef.current;
      if (
        scrollState &&
        Array.from(event.changedTouches).some((touch) => touch.identifier === scrollState.touchId)
      ) {
        touchScrollStateRef.current = null;
      }
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    mount.addEventListener("touchstart", handleTouchStart, { passive: true });
    mount.addEventListener("touchmove", handleTouchMove, { passive: false });
    mount.addEventListener("touchend", handleTouchEnd);
    mount.addEventListener("touchcancel", handleTouchCancel);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = (event: TerminalEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        writeTerminalSnapshot(activeTerminal, event.snapshot);
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

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
        handleSessionExited();
      }, 0);
    };
    const applyPendingTerminalEvents = (
      terminalEventEntries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
    ) => {
      const pendingEntries = selectPendingTerminalEventEntries(
        terminalEventEntries,
        lastAppliedTerminalEventIdRef.current,
      );
      if (pendingEntries.length === 0) {
        return;
      }
      for (const entry of pendingEntries) {
        applyTerminalEvent(entry.event);
      }
      lastAppliedTerminalEventIdRef.current =
        pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventIdRef.current;
    };

    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (!terminalHydratedRef.current) {
        return;
      }

      const previousLastEntryId =
        selectTerminalEventEntries(
          previousState.terminalEventEntriesByKey,
          threadRef,
          terminalId,
        ).at(-1)?.id ?? 0;
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        threadRef,
        terminalId,
      );
      const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
      if (nextLastEntryId === previousLastEntryId) {
        return;
      }

      applyPendingTerminalEvents(nextEntries);
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
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
        const bufferedEntries = selectTerminalEventEntries(
          useTerminalStateStore.getState().terminalEventEntriesByKey,
          threadRef,
          terminalId,
        );
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          bufferedEntries,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          applyTerminalEvent(entry.event);
        }
        lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        terminalHydratedRef.current = true;
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
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      cancelLongPress();
      window.clearTimeout(fitTimer);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("touchstart", handleTouchStart);
      mount.removeEventListener("touchmove", handleTouchMove);
      mount.removeEventListener("touchend", handleTouchEnd);
      mount.removeEventListener("touchcancel", handleTouchCancel);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environmentId, runtimeEnv, terminalId, threadId]);

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
    const api = readEnvironmentApi(environmentId);
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
  }, [drawerHeight, environmentId, resizeEpoch, terminalId, threadId]);
  return (
    <div
      ref={containerRef}
      data-mobile-edge-swipe-block="true"
      className="relative h-full w-full touch-none overflow-hidden rounded-[4px] bg-background"
    />
  );
}

interface ThreadTerminalDrawerProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
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
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
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

interface TerminalAccessoryKeyBarProps {
  armedModifier: TerminalModifier | null;
  onKeyDown: (key: TerminalAccessoryKey) => void;
}

function TerminalAccessoryKeyBar({ armedModifier, onKeyDown }: TerminalAccessoryKeyBarProps) {
  return (
    <div
      // The bar spans the screen's right edge, so its horizontal scroll would
      // otherwise be read as a right edge-swipe and open the sidebar.
      data-mobile-edge-swipe-block="true"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 bg-background px-2 py-1.5 [scrollbar-width:none]"
    >
      {TERMINAL_ACCESSORY_KEYS.map((key) => {
        const isArmed = key.kind === "modifier" && armedModifier === key.modifier;
        return (
          <button
            key={key.id}
            type="button"
            tabIndex={-1}
            aria-label={key.ariaLabel}
            aria-pressed={key.kind === "modifier" ? isArmed : undefined}
            className={`inline-flex h-8 min-w-9 shrink-0 items-center justify-center rounded-md border px-2 font-mono text-sm leading-none transition-colors ${
              isArmed
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/70 bg-muted/30 text-foreground/90 active:bg-accent"
            }`}
            // Prevent the default mousedown so tapping a key never blurs the
            // terminal's hidden textarea (which would dismiss the soft keyboard).
            // The key is sent on click instead — the browser suppresses click
            // when a touch becomes a scroll, so dragging the bar scrolls rather
            // than firing buttons.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onKeyDown(key)}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ThreadTerminalDrawer({
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
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
  onAddTerminalContext,
  keybindings,
}: ThreadTerminalDrawerProps) {
  const isMobile = useIsMobile();
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(height));
  const [keyboardViewport, setKeyboardViewport] = useState<TerminalKeyboardViewport>(
    EMPTY_TERMINAL_KEYBOARD_VIEWPORT,
  );
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerHeightRef = useRef(drawerHeight);
  const keyboardViewportRef = useRef(keyboardViewport);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const pendingTerminalModifierRef = useRef<TerminalModifier | null>(null);
  const [armedModifier, setArmedModifier] = useState<TerminalModifier | null>(null);

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
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () =>
      new Map(
        normalizedTerminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
      ),
    [normalizedTerminalIds],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal (${splitShortcutLabel})`
      : "Split Terminal";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const renderedDrawerHeight = resolveRenderedDrawerHeight(drawerHeight, keyboardViewport);
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  const sendActiveTerminalInput = useCallback(
    (data: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      void api.terminal
        .write({ threadId, terminalId: resolvedActiveTerminalId, data })
        .catch(() => undefined);
    },
    [resolvedActiveTerminalId, threadId, threadRef.environmentId],
  );

  const handleModifierConsumed = useCallback(() => {
    setArmedModifier(null);
  }, []);

  const handleAccessoryKey = useCallback(
    (key: TerminalAccessoryKey) => {
      if (key.kind === "modifier") {
        setArmedModifier((current) => {
          const next = current === key.modifier ? null : key.modifier;
          pendingTerminalModifierRef.current = next;
          return next;
        });
        return;
      }
      // A pending Ctrl latch only applies to the next character typed on the
      // soft keyboard, not to another accessory key — clear it and send the key.
      if (pendingTerminalModifierRef.current !== null) {
        pendingTerminalModifierRef.current = null;
        setArmedModifier(null);
      }
      sendActiveTerminalInput(key.data);
    },
    [sendActiveTerminalInput],
  );

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const applyKeyboardViewport = useCallback((nextViewport: TerminalKeyboardViewport) => {
    if (terminalKeyboardViewportEqual(keyboardViewportRef.current, nextViewport)) {
      return;
    }
    keyboardViewportRef.current = nextViewport;
    setKeyboardViewport(nextViewport);
    setResizeEpoch((value) => value + 1);
  }, []);

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
    if (!visible) {
      applyKeyboardViewport(EMPTY_TERMINAL_KEYBOARD_VIEWPORT);
      return;
    }

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
  }, [applyKeyboardViewport, syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      applyKeyboardViewport(EMPTY_TERMINAL_KEYBOARD_VIEWPORT);
      return;
    }

    let frame: number | null = null;
    let focusOutTimer: number | null = null;

    const updateKeyboardViewport = () => {
      frame = null;
      const drawer = drawerRef.current;
      const activeElement = document.activeElement;
      const terminalFocused = Boolean(
        drawer && activeElement instanceof Node && drawer.contains(activeElement),
      );
      applyKeyboardViewport(
        terminalFocused ? readTerminalKeyboardViewport() : EMPTY_TERMINAL_KEYBOARD_VIEWPORT,
      );
    };

    const scheduleKeyboardViewportUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateKeyboardViewport);
    };

    const onFocusOut = () => {
      if (focusOutTimer !== null) {
        window.clearTimeout(focusOutTimer);
      }
      focusOutTimer = window.setTimeout(() => {
        focusOutTimer = null;
        scheduleKeyboardViewportUpdate();
      }, 0);
    };

    const visualViewport = window.visualViewport;
    document.addEventListener("focusin", scheduleKeyboardViewportUpdate);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", scheduleKeyboardViewportUpdate);
    visualViewport?.addEventListener("resize", scheduleKeyboardViewportUpdate);
    visualViewport?.addEventListener("scroll", scheduleKeyboardViewportUpdate);
    scheduleKeyboardViewportUpdate();

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      if (focusOutTimer !== null) {
        window.clearTimeout(focusOutTimer);
      }
      document.removeEventListener("focusin", scheduleKeyboardViewportUpdate);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", scheduleKeyboardViewportUpdate);
      visualViewport?.removeEventListener("resize", scheduleKeyboardViewportUpdate);
      visualViewport?.removeEventListener("scroll", scheduleKeyboardViewportUpdate);
    };
  }, [applyKeyboardViewport, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  return (
    <aside
      ref={drawerRef}
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{
        height: `${renderedDrawerHeight}px`,
        marginBottom:
          keyboardViewport.bottomInset > 0 ? `${keyboardViewport.bottomInset}px` : undefined,
      }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
      />

      {!hasTerminalSidebar &&
        (isMobile ? (
          <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border/60 bg-background px-2 pb-1 pt-1.5">
            <TerminalActionButton
              className={`inline-flex size-8 items-center justify-center rounded-md text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45"
                  : "hover:bg-accent active:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-4" />
            </TerminalActionButton>
            <TerminalActionButton
              className="inline-flex size-8 items-center justify-center rounded-md text-foreground/90 transition-colors hover:bg-accent active:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-4" />
            </TerminalActionButton>
            <TerminalActionButton
              className="inline-flex size-8 items-center justify-center rounded-md text-foreground/90 transition-colors hover:bg-accent active:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-4" />
            </TerminalActionButton>
          </div>
        ) : (
          <div className="pointer-events-none absolute right-2 top-2 z-20">
            <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
              <TerminalActionButton
                className={`p-1 text-foreground/90 transition-colors ${
                  hasReachedSplitLimit
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
                className="p-1 text-foreground/90 transition-colors hover:bg-accent"
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
        ))}

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
                        threadRef={threadRef}
                        threadId={threadId}
                        terminalId={terminalId}
                        terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                        cwd={cwd}
                        {...(worktreePath !== undefined ? { worktreePath } : {})}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        onAddTerminalContext={onAddTerminalContext}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        resizeEpoch={resizeEpoch}
                        drawerHeight={renderedDrawerHeight}
                        keybindings={keybindings}
                        pendingModifierRef={pendingTerminalModifierRef}
                        onModifierConsumed={handleModifierConsumed}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadRef={threadRef}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(worktreePath !== undefined ? { worktreePath } : {})}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={renderedDrawerHeight}
                  keybindings={keybindings}
                  pendingModifierRef={pendingTerminalModifierRef}
                  onModifierConsumed={handleModifierConsumed}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside
              className={`flex flex-col border border-border/70 bg-muted/10 ${
                isMobile ? "w-32 min-w-32" : "w-36 min-w-36"
              }`}
            >
              <div
                className={`flex items-stretch justify-end border-b border-border/70 ${
                  isMobile ? "h-9" : "h-[22px]"
                }`}
              >
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center ${
                      isMobile ? "px-2" : "px-1"
                    } text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70 active:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className={isMobile ? "size-4" : "size-3.25"} />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 ${
                      isMobile ? "px-2" : "px-1"
                    } text-foreground/90 transition-colors hover:bg-accent/70 active:bg-accent/70`}
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className={isMobile ? "size-4" : "size-3.25"} />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 ${
                      isMobile ? "px-2" : "px-1"
                    } text-foreground/90 transition-colors hover:bg-accent/70 active:bg-accent/70`}
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className={isMobile ? "size-4" : "size-3.25"} />
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

      {isMobile && keyboardViewport.bottomInset > 0 && (
        <TerminalAccessoryKeyBar armedModifier={armedModifier} onKeyDown={handleAccessoryKey} />
      )}
    </aside>
  );
}
