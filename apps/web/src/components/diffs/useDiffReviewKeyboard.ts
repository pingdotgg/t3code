import { useAtomValue } from "@effect/atom-react";
import type {
  CodeViewLineScrollTarget,
  CodeViewLineSelection,
  FileDiffMetadata,
  HunkExpansionRegion,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { KeybindingCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createContext, use, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import { diffPanelHasFocus } from "~/lib/diffFocus";
import { type CommandHandlers, registerCommands } from "~/shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "~/state/server";

import {
  adjacentFileKey,
  adjacentUnviewedFileKey,
  cursorFromSelectedRange,
  cursorSelectedRange,
  type DiffReviewCursor,
  type DiffRowRef,
  fileScrollAlign,
  fileToStartFrom,
  nearestGapExpansion,
  stepRow,
  topToBottomRange,
  visibleDiffRows,
} from "./diffReviewCursor";

const DIFF_REVIEW_COMMANDS = [
  "diff.nextFile",
  "diff.previousFile",
  "diff.nextUnviewedFile",
  "diff.previousUnviewedFile",
  "diff.toggleFileCollapsed",
  "diff.toggleFileViewed",
  "diff.toggleSingleFile",
  "diff.enterLineMode",
  "diff.nextLine",
  "diff.previousLine",
  "diff.expandBelow",
  "diff.expandAbove",
  "diff.comment",
  "diff.startSelection",
  "diff.back",
] as const satisfies ReadonlyArray<KeybindingCommand>;
type DiffReviewCommand = (typeof DIFF_REVIEW_COMMANDS)[number];

// Holding these keeps moving; holding a toggle would flip it on every repeat.
const REPEATABLE_COMMANDS: ReadonlySet<DiffReviewCommand> = new Set([
  "diff.nextFile",
  "diff.previousFile",
  "diff.nextUnviewedFile",
  "diff.previousUnviewedFile",
  "diff.nextLine",
  "diff.previousLine",
  "diff.expandBelow",
  "diff.expandAbove",
]);

const NO_EXPANSIONS: ReadonlyMap<number, HunkExpansionRegion> = new Map();
const SINGLE_FILE_STORAGE_KEY = "t3code.diffSingleFile";
// The viewer's 100 lines per step pushes the cursor far off screen; a small step stays readable.
const KEYBOARD_EXPANSION_LINES = 20;

const CONTROL_SELECTOR =
  'button, a[href], input, select, [role="button"], [role="checkbox"], [role="switch"]';

function isControlFocused(): boolean {
  return (document.activeElement?.closest(CONTROL_SELECTOR) ?? null) !== null;
}

/**
 * The review cursor, kept outside React state: a key press redraws only what shows the cursor,
 * not the panel around it. One store belongs to one diff scope.
 */
export interface DiffReviewCursorStore {
  readonly get: () => DiffReviewCursor | null;
  readonly getSelectedLines: () => CodeViewLineSelection | null;
  readonly subscribe: (listener: () => void) => () => void;
}

interface WritableDiffReviewCursorStore extends DiffReviewCursorStore {
  readonly set: (cursor: DiffReviewCursor | null) => void;
}

function createDiffReviewCursorStore(): WritableDiffReviewCursorStore {
  let cursor: DiffReviewCursor | null = null;
  let selectedLines: CodeViewLineSelection | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => cursor,
    getSelectedLines: () => selectedLines,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      cursor = next;
      const range = next ? cursorSelectedRange(next) : null;
      selectedLines = next && range ? { id: next.fileKey, range } : null;
      for (const listener of listeners) listener();
    },
  };
}

const NO_CURSOR_STORE: DiffReviewCursorStore = {
  get: () => null,
  getSelectedLines: () => null,
  subscribe: () => () => {},
};

export const DiffReviewCursorContext = createContext<DiffReviewCursorStore>(NO_CURSOR_STORE);

/** Whether the review cursor is on the file; matched by path, which survives lazy loading. */
export function useIsDiffReviewCursorFile(filePath: string): boolean {
  const store = use(DiffReviewCursorContext);
  return useSyncExternalStore(store.subscribe, () => store.get()?.filePath === filePath);
}

export function useDiffReviewCursorFilePath(): string | null {
  const store = use(DiffReviewCursorContext);
  return useSyncExternalStore(store.subscribe, () => store.get()?.filePath ?? null);
}

/** The cursor's lines as a viewer selection; changes only when the selection does. */
export function useDiffReviewSelectedLines(): CodeViewLineSelection | null {
  const store = use(DiffReviewCursorContext);
  return useSyncExternalStore(store.subscribe, store.getSelectedLines);
}

export interface DiffReviewFile {
  readonly fileKey: string;
  readonly filePath: string;
  readonly fileDiff: FileDiffMetadata;
  /** Loaded and drawn by the viewer; placeholders can be visited but not reviewed. */
  readonly rendered: boolean;
}

interface DiffReviewKeyboardInput<Annotation> {
  /** The thread and diff scope; a new one starts without a cursor. */
  readonly scopeKey: string | null;
  readonly files: ReadonlyArray<DiffReviewFile>;
  readonly diffStyle: "unified" | "split";
  /** Partial diffs only expand when the full files can be loaded. */
  readonly canLoadFullFiles: boolean;
  readonly autoAdvanceOnViewed: boolean;
  readonly getViewer: () => CodeViewHandle<Annotation, undefined> | null;
  readonly isCollapsed: (fileKey: string) => boolean;
  readonly setCollapsed: (fileKey: string, collapsed: boolean) => void;
  readonly isViewed: (file: DiffReviewFile) => boolean;
  /** Null where files can't be marked viewed, which leaves the key to others. */
  readonly setViewed: ((file: DiffReviewFile, viewed: boolean) => void) | null;
  /** Loads the file if needed and scrolls it into view. */
  readonly revealFile: (file: DiffReviewFile, align?: "start" | "nearest") => void;
  readonly beginComment: (fileKey: string, range: SelectedLineRange) => void;
}

/**
 * Keyboard review of the Diff panel: a file cursor, a line cursor inside a file, and a line
 * selection. Commands run through the shortcut dispatcher while focus is in the diff's panel.
 */
export function useDiffReviewKeyboard<Annotation>(input: DiffReviewKeyboardInput<Annotation>) {
  const { scopeKey, files } = input;
  const [scopedStore, setScopedStore] = useState(() => ({
    scopeKey,
    store: createDiffReviewCursorStore(),
  }));
  if (scopedStore.scopeKey !== scopeKey) {
    setScopedStore({ scopeKey, store: createDiffReviewCursorStore() });
  }
  const cursorStore = scopedStore.store;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Shows only the cursor's file, forced open; one preference for every diff view.
  const [singleFile, setSingleFile] = useLocalStorage(
    SINGLE_FILE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pendingScrollRef = useRef<CodeViewLineScrollTarget | null>(null);
  // Chrome marks a clicked control :focus-visible on the next key press, so record how focus came.
  const tabbedToRef = useRef<EventTarget | null>(null);

  // Only single-file mode redraws the panel as the cursor moves, since the shown file changes.
  const singleFilePath = useSyncExternalStore(cursorStore.subscribe, () =>
    singleFile ? (cursorStore.get()?.filePath ?? null) : null,
  );
  const singleFileKey = singleFile
    ? (files.find((file) => file.filePath === singleFilePath) ?? files[0])?.fileKey
    : undefined;
  const isCollapsed = (fileKey: string) => fileKey !== singleFileKey && input.isCollapsed(fileKey);
  // Read when a key runs, not in render: the panel does not redraw for a cursor move.
  const readCursor = () => {
    const stored = cursorStore.get();
    const cursorFile = stored
      ? (files.find((file) => file.fileKey === stored.fileKey) ??
        files.find((file) => file.filePath === stored.filePath) ??
        null)
      : null;
    const cursor: DiffReviewCursor | null =
      stored === null || cursorFile === null
        ? null
        : stored.mode !== "file" && (!cursorFile.rendered || isCollapsed(cursorFile.fileKey))
          ? { mode: "file", fileKey: cursorFile.fileKey, filePath: cursorFile.filePath }
          : { ...stored, fileKey: cursorFile.fileKey };
    return { cursor, cursorFile };
  };

  const setCursor = (next: DiffReviewCursor | null) => cursorStore.set(next);
  const fileCursor = (file: { fileKey: string; filePath: string }): DiffReviewCursor => ({
    mode: "file",
    fileKey: file.fileKey,
    filePath: file.filePath,
  });

  const fileDiffInstance = (fileKey: string) => {
    const item = input
      .getViewer()
      ?.getInstance()
      ?.getRenderedItems()
      .find((candidate) => candidate.id === fileKey);
    return item?.type === "diff" ? item.instance : undefined;
  };
  const rowsFor = (file: DiffReviewFile) => {
    const item = input.getViewer()?.getItem(file.fileKey);
    return visibleDiffRows(
      item?.type === "diff" ? item.fileDiff : file.fileDiff,
      input.diffStyle,
      fileDiffInstance(file.fileKey)?.getExpandedHunksForSearch() ?? NO_EXPANSIONS,
    );
  };
  const canExpand = (file: DiffReviewFile) => !file.fileDiff.isPartial || input.canLoadFullFiles;

  const flushScroll = useStableCallback(() => {
    const target = pendingScrollRef.current;
    const viewer = input.getViewer();
    if (target === null || !viewer?.getInstance()) return;
    const item = viewer.getItem(target.id);
    // A file unfolded by the same key press is drawn on a later render.
    if (!item || item.collapsed === true) return;
    pendingScrollRef.current = null;
    viewer.scrollTo(target);
  });
  const queueScrollToRow = (
    file: DiffReviewFile,
    row: DiffRowRef,
    align: "nearest" | "center" = "nearest",
  ) => {
    pendingScrollRef.current = {
      type: "line",
      id: file.fileKey,
      lineNumber: row.lineNumber,
      side: row.side,
      align,
    };
  };
  const scrollToRow = (file: DiffReviewFile, row: DiffRowRef) => {
    queueScrollToRow(file, row);
    flushScroll();
  };
  const placeFiles = () => {
    const viewer = input.getViewer()?.getInstance();
    if (!viewer) return null;
    const top = viewer.getScrollTop();
    const height = viewer.getHeight();
    return {
      placed: files.flatMap(({ fileKey }) => {
        const fileTop = viewer.getTopForItem(fileKey);
        return fileTop === undefined ? [] : [{ fileKey, top: fileTop }];
      }),
      view: { top, bottom: top + height, height, contentEnd: viewer.getScrollHeight() },
    };
  };
  const moveToFile = (fileKey: string | null) => {
    const file = files.find((candidate) => candidate.fileKey === fileKey);
    if (!file) return;
    pendingScrollRef.current = null;
    setCursor(fileCursor(file));
    // Lining every file up at the top jolts the list, and the pull request header with it.
    const placement = placeFiles();
    input.revealFile(
      file,
      placement ? fileScrollAlign(placement.placed, file.fileKey, placement.view) : "start",
    );
  };

  // After the reader scrolls away from the cursor, the file keys start from what is on screen.
  const fileKeyInView = (cursorKey: string | null) => {
    const placement = placeFiles();
    return placement ? fileToStartFrom(placement.placed, cursorKey, placement.view) : null;
  };

  const toggleFileCollapsed = useStableCallback((fileKey: string) => {
    // Single-file mode keeps its file open, so closing that file returns to the full list.
    if (fileKey === singleFileKey) setSingleFile(false);
    input.setCollapsed(fileKey, !isCollapsed(fileKey));
  });

  const runCommand = (command: DiffReviewCommand): boolean => {
    const { cursor, cursorFile } = readCursor();
    const range = cursor ? cursorSelectedRange(cursor) : null;
    const fileKeys = files.map((file) => file.fileKey);
    const currentKey = cursorFile?.fileKey ?? null;
    const isKeyViewed = (fileKey: string) => {
      const file = files.find((candidate) => candidate.fileKey === fileKey);
      return file !== undefined && input.isViewed(file);
    };
    switch (command) {
      case "diff.nextFile":
      case "diff.previousFile": {
        if (files.length === 0) return false;
        const delta = command === "diff.nextFile" ? 1 : -1;
        moveToFile(fileKeyInView(currentKey) ?? adjacentFileKey(fileKeys, currentKey, delta));
        return true;
      }
      case "diff.nextUnviewedFile":
      case "diff.previousUnviewedFile": {
        if (files.length === 0) return false;
        const delta = command === "diff.nextUnviewedFile" ? 1 : -1;
        const inView = fileKeyInView(currentKey);
        moveToFile(
          inView !== null && !isKeyViewed(inView)
            ? inView
            : adjacentUnviewedFileKey(fileKeys, inView ?? currentKey, delta, isKeyViewed),
        );
        return true;
      }
      case "diff.toggleFileCollapsed": {
        if (!cursorFile) return false;
        toggleFileCollapsed(cursorFile.fileKey);
        return true;
      }
      case "diff.toggleFileViewed": {
        if (!cursorFile || !input.setViewed) return false;
        if (!cursorFile.rendered) return true;
        const viewed = !input.isViewed(cursorFile);
        input.setViewed(cursorFile, viewed);
        input.setCollapsed(cursorFile.fileKey, viewed);
        const nextKey =
          viewed && input.autoAdvanceOnViewed
            ? adjacentUnviewedFileKey(
                fileKeys,
                cursorFile.fileKey,
                1,
                (fileKey) => fileKey === cursorFile.fileKey || isKeyViewed(fileKey),
              )
            : null;
        moveToFile(nextKey ?? cursorFile.fileKey);
        return true;
      }
      case "diff.toggleSingleFile": {
        const file = cursorFile ?? files[0];
        if (!file) return false;
        setCursor(fileCursor(file));
        setSingleFile(!singleFile);
        input.revealFile(file);
        return true;
      }
      case "diff.enterLineMode": {
        const file = cursorFile ?? files[0];
        if (!file) return false;
        if (!file.rendered) return true;
        const firstRow = rowsFor(file)[0];
        if (!firstRow) return true;
        input.setCollapsed(file.fileKey, false);
        // Shift+J and Shift+K need the full file; loading it on the first one draws the new
        // lines after the scroll that should follow them.
        if (canExpand(file)) void fileDiffInstance(file.fileKey)?.prepareForEditing();
        setCursor({ mode: "line", fileKey: file.fileKey, filePath: file.filePath, row: firstRow });
        scrollToRow(file, firstRow);
        return true;
      }
      case "diff.nextLine":
      case "diff.previousLine": {
        if (!cursor || !cursorFile || cursor.mode === "file") return false;
        const delta = command === "diff.nextLine" ? 1 : -1;
        const rows = rowsFor(cursorFile);
        const at = cursor.mode === "line" ? cursor.row : cursor.head;
        const next = stepRow(rows, at, delta);
        if (!next) return true;
        if (cursor.mode === "line" && next.lineNumber === at.lineNumber && next.side === at.side) {
          // Stepping past the first line returns to the file, past the last on to the next file.
          const fileKey =
            delta === -1 ? cursorFile.fileKey : adjacentFileKey(fileKeys, cursorFile.fileKey, 1);
          if (delta === -1 || fileKey !== cursorFile.fileKey) moveToFile(fileKey);
          return true;
        }
        const row: DiffRowRef = { lineNumber: next.lineNumber, side: next.side };
        setCursor(cursor.mode === "line" ? { ...cursor, row } : { ...cursor, head: row });
        scrollToRow(cursorFile, row);
        return true;
      }
      case "diff.expandBelow":
      case "diff.expandAbove": {
        if (!cursor || !cursorFile || cursor.mode === "file") return false;
        const instance = fileDiffInstance(cursorFile.fileKey);
        if (!instance || !canExpand(cursorFile)) return true;
        const row = cursor.mode === "line" ? cursor.row : cursor.head;
        const gap = nearestGapExpansion(
          cursorFile.fileDiff,
          rowsFor(cursorFile),
          row,
          command === "diff.expandBelow" ? "below" : "above",
        );
        if (!gap) return true;
        instance.expandHunk(gap.hunkIndex, gap.direction, KEYBOARD_EXPANSION_LINES);
        if (command === "diff.expandAbove") {
          // Lines added above push the cursor down by heights the viewer only estimates until
          // drawn, so centre it rather than aim for an edge it can miss.
          queueScrollToRow(cursorFile, row, "center");
        }
        return true;
      }
      case "diff.comment": {
        if (!cursor || !cursorFile || !range) return false;
        input.beginComment(cursorFile.fileKey, topToBottomRange(range, rowsFor(cursorFile)));
        return true;
      }
      case "diff.startSelection": {
        if (!cursor || cursor.mode === "file") return false;
        const anchor = cursor.mode === "line" ? cursor.row : cursor.head;
        setCursor({
          mode: "select",
          fileKey: cursor.fileKey,
          filePath: cursor.filePath,
          anchor,
          head: anchor,
        });
        return true;
      }
      case "diff.back": {
        if (!cursor || cursor.mode === "file") return false;
        setCursor(
          cursor.mode === "select"
            ? { mode: "line", fileKey: cursor.fileKey, filePath: cursor.filePath, row: cursor.head }
            : fileCursor(cursor),
        );
        return true;
      }
    }
  };

  const handleCommand = useStableCallback((command: DiffReviewCommand, event: KeyboardEvent) => {
    const handled = event.repeat && !REPEATABLE_COMMANDS.has(command) ? true : runCommand(command);
    if (handled) {
      event.preventDefault();
      // The viewer drops a scroll requested during a key press that reaches it.
      event.stopPropagation();
      // The key now drives the diff, so a control keeping focus would show a stale focus ring.
      const root = rootRef.current;
      if (root && (isControlFocused() || !root.contains(document.activeElement))) {
        root.focus({ preventScroll: true });
      }
    }
    return handled;
  });
  const isLineMode = useStableCallback(() => {
    const { cursor } = readCursor();
    return cursor !== null && cursor.mode !== "file";
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the review keys with the app-wide shortcut dispatcher while the panel is mounted
  useEffect(() => {
    const handlers: CommandHandlers = {};
    for (const command of DIFF_REVIEW_COMMANDS) {
      handlers[command] = (event) => handleCommand(command, event);
    }
    let lastInputWasKeyboard = false;
    const onPointerDown = () => {
      lastInputWasKeyboard = false;
    };
    const onKeyDown = () => {
      lastInputWasKeyboard = true;
    };
    const onFocusIn = (event: FocusEvent) => {
      tabbedToRef.current = lastInputWasKeyboard ? event.target : null;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    // Capture phase, so the keys reach the panel before type-to-focus sends them to the composer.
    const unregister = registerCommands(handlers, {
      capture: true,
      when: (event) => {
        if (!rootRef.current || !diffPanelHasFocus(rootRef.current)) return false;
        // A control reached from the keyboard keeps Enter; a clicked one hands it over.
        return !(
          event.key === "Enter" &&
          isControlFocused() &&
          document.activeElement === tabbedToRef.current
        );
      },
      context: () => ({ diffLineMode: isLineMode() }),
    });
    return () => {
      unregister();
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
    };
  }, [handleCommand, isLineMode]);

  const labelFor = (command: DiffReviewCommand, diffLineMode = false) =>
    shortcutLabelForCommand(keybindings, command, { context: { diffFocus: true, diffLineMode } });

  return {
    cursorStore,
    singleFile,
    singleFileKey,
    rootRef,
    flushScroll,
    shortcutLabels: {
      viewed: labelFor("diff.toggleFileViewed"),
      comment: labelFor("diff.comment", true),
      singleFile: labelFor("diff.toggleSingleFile"),
    },
    toggleSingleFile: () => runCommand("diff.toggleSingleFile"),
    toggleFileCollapsed,
    /** Leaves single-file mode, for actions that only make sense in the full list. */
    showAllFiles: () => setSingleFile(false),
    /** Puts the file cursor on a file the user picked another way, such as the file tree. */
    selectFile: (filePath: string) => {
      const file = files.find((candidate) => candidate.filePath === filePath);
      if (file) setCursor(fileCursor(file));
    },
    onSelectedLinesChange: (selection: CodeViewLineSelection | null) => {
      if (selection === null) {
        const { cursor } = readCursor();
        if (cursor && cursor.mode !== "file") setCursor(fileCursor(cursor));
        return;
      }
      const file = files.find((candidate) => candidate.fileKey === selection.id);
      if (file) setCursor(cursorFromSelectedRange(file, selection.range));
    },
    // The draft's textarea held focus; without this it falls to the page and the keys stop.
    onDraftClose: () => {
      const { cursor } = readCursor();
      if (cursor?.mode === "select") {
        setCursor({
          mode: "line",
          fileKey: cursor.fileKey,
          filePath: cursor.filePath,
          row: cursor.head,
        });
      }
      rootRef.current?.focus({ preventScroll: true });
    },
  };
}
