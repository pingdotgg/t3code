import type {
  CodeViewLineScrollTarget,
  CodeViewLineSelection,
  FileDiffMetadata,
  HunkExpansionRegion,
} from "@pierre/diffs";
import type { KeybindingCommand } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { type CommandHandlers, registerCommands } from "~/shortcuts/dispatcher";

import type { AnnotatableCodeViewHandle, AnnotatableCodeViewReview } from "./AnnotatableCodeView";
import {
  adjacentFileKey,
  adjacentUnviewedFileKey,
  cursorFromSelectedRange,
  cursorSelectedRange,
  type DiffReviewCursor,
  type DiffRowRef,
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

// A control reached with Tab keeps Enter and Space; one focused by a click hands them to the cursor.
function activatesFocusedControl(event: KeyboardEvent, root: HTMLElement | null): boolean {
  return (
    (event.key === "Enter" || event.key === " ") &&
    event.target instanceof Element &&
    event.target !== root &&
    event.target.matches(":focus-visible") &&
    event.target.closest(
      'button, a[href], input, select, [role="button"], [role="checkbox"], [role="switch"]',
    ) !== null
  );
}

export interface DiffReviewFile {
  readonly fileKey: string;
  readonly filePath: string;
  readonly fileDiff: FileDiffMetadata;
  /** Loaded and drawn by the viewer; placeholders can be visited but not reviewed. */
  readonly rendered: boolean;
}

interface DiffReviewKeyboardInput {
  /** The thread and diff scope; a new one starts without a cursor. */
  readonly scopeKey: string | null;
  readonly files: ReadonlyArray<DiffReviewFile>;
  readonly diffStyle: "unified" | "split";
  /** Partial diffs only expand when the full files can be loaded. */
  readonly canLoadFullFiles: boolean;
  readonly autoAdvanceOnViewed: boolean;
  readonly getViewer: () => AnnotatableCodeViewHandle | null;
  readonly isCollapsed: (fileKey: string) => boolean;
  readonly setCollapsed: (fileKey: string, collapsed: boolean) => void;
  readonly isViewed: (file: DiffReviewFile) => boolean;
  readonly setViewed: (file: DiffReviewFile, viewed: boolean) => void;
  /** Loads the file if needed and scrolls its header into view. */
  readonly revealFile: (file: DiffReviewFile) => void;
  /** Shows only the cursor's file, forced open. */
  readonly singleFile: boolean;
  readonly setSingleFile: (singleFile: boolean) => void;
}

/**
 * Keyboard review of the Diff panel: a file cursor, a line cursor inside a file, and a line
 * selection. Commands run through the shortcut dispatcher while focus is inside the panel.
 */
export function useDiffReviewKeyboard(input: DiffReviewKeyboardInput) {
  const { scopeKey, files } = input;
  const [cursorState, setCursorState] = useState<{
    readonly scopeKey: string | null;
    readonly cursor: DiffReviewCursor | null;
  }>({ scopeKey, cursor: null });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reviewRef = useRef<AnnotatableCodeViewReview | null>(null);
  const pendingScrollRef = useRef<CodeViewLineScrollTarget | null>(null);

  const storedCursor = cursorState.scopeKey === scopeKey ? cursorState.cursor : null;
  const cursorFile = storedCursor
    ? (files.find((file) => file.fileKey === storedCursor.fileKey) ??
      files.find((file) => file.filePath === storedCursor.filePath) ??
      null)
    : null;
  const singleFileKey = input.singleFile ? (cursorFile ?? files[0])?.fileKey : undefined;
  const isCollapsed = (fileKey: string) => fileKey !== singleFileKey && input.isCollapsed(fileKey);
  const cursor: DiffReviewCursor | null =
    storedCursor === null || cursorFile === null
      ? null
      : storedCursor.mode !== "file" && (!cursorFile.rendered || isCollapsed(cursorFile.fileKey))
        ? { mode: "file", fileKey: cursorFile.fileKey, filePath: cursorFile.filePath }
        : { ...storedCursor, fileKey: cursorFile.fileKey };
  const range = cursor ? cursorSelectedRange(cursor) : null;
  const selectedLines: CodeViewLineSelection | null =
    cursor && range ? { id: cursor.fileKey, range } : null;

  const setCursor = (next: DiffReviewCursor | null) => setCursorState({ scopeKey, cursor: next });
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
  const rowsFor = (file: DiffReviewFile) =>
    visibleDiffRows(
      file.fileDiff,
      input.diffStyle,
      fileDiffInstance(file.fileKey)?.getExpandedHunks() ?? NO_EXPANSIONS,
    );
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
  const scrollToRow = (file: DiffReviewFile, row: DiffRowRef) => {
    pendingScrollRef.current = {
      type: "line",
      id: file.fileKey,
      lineNumber: row.lineNumber,
      side: row.side,
      align: "nearest",
    };
    flushScroll();
  };
  const moveToFile = (fileKey: string | null) => {
    const file = files.find((candidate) => candidate.fileKey === fileKey);
    if (!file) return;
    pendingScrollRef.current = null;
    setCursor(fileCursor(file));
    input.revealFile(file);
  };

  const runCommand = (command: DiffReviewCommand): boolean => {
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
        moveToFile(adjacentFileKey(fileKeys, currentKey, command === "diff.nextFile" ? 1 : -1));
        return true;
      }
      case "diff.nextUnviewedFile":
      case "diff.previousUnviewedFile": {
        if (files.length === 0) return false;
        const delta = command === "diff.nextUnviewedFile" ? 1 : -1;
        moveToFile(adjacentUnviewedFileKey(fileKeys, currentKey, delta, isKeyViewed));
        return true;
      }
      case "diff.toggleFileCollapsed": {
        if (!cursorFile) return false;
        input.setCollapsed(cursorFile.fileKey, !isCollapsed(cursorFile.fileKey));
        return true;
      }
      case "diff.toggleFileViewed": {
        if (!cursorFile) return false;
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
        input.setSingleFile(!input.singleFile);
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
        setCursor({ mode: "line", fileKey: file.fileKey, filePath: file.filePath, row: firstRow });
        scrollToRow(file, firstRow);
        return true;
      }
      case "diff.nextLine":
      case "diff.previousLine": {
        if (!cursor || !cursorFile || cursor.mode === "file") return false;
        const delta = command === "diff.nextLine" ? 1 : -1;
        const rows = rowsFor(cursorFile);
        const next = stepRow(rows, cursor.mode === "line" ? cursor.row : cursor.head, delta);
        if (!next) return true;
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
        const gap = nearestGapExpansion(
          cursorFile.fileDiff,
          rowsFor(cursorFile),
          cursor.mode === "line" ? cursor.row : cursor.head,
          command === "diff.expandBelow" ? "below" : "above",
        );
        if (gap) instance.expandHunk(gap.hunkIndex, gap.direction);
        return true;
      }
      case "diff.comment": {
        if (!cursor || !cursorFile || !range) return false;
        reviewRef.current?.beginComment(
          cursorFile.fileKey,
          topToBottomRange(range, rowsFor(cursorFile)),
        );
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
    }
    return handled;
  });
  const isLineMode = useStableCallback(() => cursor !== null && cursor.mode !== "file");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the review keys with the app-wide shortcut dispatcher while the panel is mounted
  useEffect(() => {
    const handlers: CommandHandlers = {};
    for (const command of DIFF_REVIEW_COMMANDS) {
      handlers[command] = (event) => handleCommand(command, event);
    }
    // Capture phase, so the keys reach the panel before type-to-focus sends them to the composer.
    return registerCommands(handlers, {
      capture: true,
      when: (event) =>
        rootRef.current?.contains(document.activeElement) === true &&
        !activatesFocusedControl(event, rootRef.current),
      context: () => ({ diffLineMode: isLineMode() }),
    });
  }, [handleCommand, isLineMode]);

  return {
    cursor,
    singleFileKey,
    selectedLines,
    rootRef,
    reviewRef,
    flushScroll,
    toggleSingleFile: () => runCommand("diff.toggleSingleFile"),
    /** Puts the file cursor on a file the user picked another way, such as the file tree. */
    selectFile: (filePath: string) => {
      const file = files.find((candidate) => candidate.filePath === filePath);
      if (file) setCursor(fileCursor(file));
    },
    onSelectedLinesChange: (selection: CodeViewLineSelection | null) => {
      if (selection === null) {
        if (cursor && cursor.mode !== "file") setCursor(fileCursor(cursor));
        return;
      }
      const file = files.find((candidate) => candidate.fileKey === selection.id);
      if (file) setCursor(cursorFromSelectedRange(file, selection.range));
    },
    // The draft's textarea held focus; without this it falls to the page and the keys stop.
    onDraftClose: () => {
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
