export const LIST_PANE_WIDTH = 34;
export const RIGHT_PANEL_WIDTH = 32;
export const MIN_CHAT_PANE_WIDTH = 48;
export const COMPOSER_MIN_EDITOR_ROWS = 3;
export const COMPOSER_MAX_EDITOR_ROWS = 8;
export const MIN_TERMINAL_DRAWER_ROWS = 6;
export const MIN_TIMELINE_ROWS = 4;
export const STATUS_ROWS = 1;

export interface ChatColumnLayout {
  readonly sidebarVisible: boolean;
  readonly listWidth: number;
  readonly mainWidth: number;
  readonly chatWidth: number;
  readonly rightWidth: number;
  readonly rightPanelAsMain: boolean;
}

/**
 * Follow the web shell's responsive hierarchy: preserve a usable conversation
 * column first, then dock the project and detail sidebars only when they fit.
 */
export function resolveChatColumnLayout(
  terminalWidth: number,
  rightPanelVisible: boolean,
): ChatColumnLayout {
  const width = Math.max(1, Math.floor(terminalWidth));
  const sidebarVisible = width >= LIST_PANE_WIDTH + MIN_CHAT_PANE_WIDTH;
  const listWidth = sidebarVisible ? LIST_PANE_WIDTH : 0;
  const mainWidth = Math.max(1, width - listWidth);
  const rightPanelAsMain = rightPanelVisible && mainWidth < RIGHT_PANEL_WIDTH + MIN_CHAT_PANE_WIDTH;
  const rightWidth = rightPanelVisible && !rightPanelAsMain ? RIGHT_PANEL_WIDTH : 0;
  return {
    sidebarVisible,
    listWidth,
    mainWidth,
    chatWidth: Math.max(1, mainWidth - rightWidth),
    rightWidth,
    rightPanelAsMain,
  };
}

/** Rows available to project/thread items after full-height sidebar chrome. */
export function resolveSidebarListViewport(terminalHeight: number): number {
  // Border (2), title (1), search with margins (5), heading (1), overflow hint (1).
  return Math.max(1, Math.floor(terminalHeight) - 10);
}

/** Estimate the textarea's visual lines, including soft wrapping. */
export function countWrappedComposerLines(text: string, contentWidth: number): number {
  const width = Math.max(1, Math.floor(contentWidth));
  if (text.length === 0) return 1;
  return text.split("\n").reduce((total, line) => {
    const displayWidth = Bun.stringWidth(line);
    return total + Math.max(1, Math.ceil(displayWidth / width));
  }, 0);
}

export interface ChatVerticalLayout {
  readonly editorRows: number;
  readonly composerRows: number;
  readonly terminalRows: number;
  readonly popoverRows: number;
  readonly panesRows: number;
}

/**
 * Allocate every terminal row once. The composer scrolls internally at its cap,
 * and an open terminal always retains a usable six-row drawer.
 */
export function resolveChatVerticalLayout(input: {
  readonly terminalHeight: number;
  readonly desiredEditorRows: number;
  /** Composer borders, footer, attachments, question panel, and context row. */
  readonly composerChromeRows: number;
  readonly terminalOpen: boolean;
  readonly preferredTerminalRows: number;
  readonly wantedPopoverRows: number;
}): ChatVerticalLayout {
  const height = Math.max(1, Math.floor(input.terminalHeight));
  const chromeRows = Math.max(0, Math.floor(input.composerChromeRows));
  const terminalReserve = input.terminalOpen ? MIN_TERMINAL_DRAWER_ROWS : 0;
  const editorBudget = Math.max(
    1,
    height - STATUS_ROWS - MIN_TIMELINE_ROWS - terminalReserve - chromeRows,
  );
  const editorRows = Math.max(
    1,
    Math.min(Math.floor(input.desiredEditorRows), COMPOSER_MAX_EDITOR_ROWS, editorBudget),
  );
  const composerRows = chromeRows + editorRows;
  const terminalBudget = Math.max(0, height - STATUS_ROWS - composerRows - MIN_TIMELINE_ROWS);
  const preferredTerminalRows = Math.max(
    MIN_TERMINAL_DRAWER_ROWS,
    Math.floor(input.preferredTerminalRows),
  );
  const terminalRows = input.terminalOpen ? Math.min(preferredTerminalRows, terminalBudget) : 0;
  const wantedPopoverRows = Math.max(0, Math.floor(input.wantedPopoverRows));
  const popoverBudget = Math.max(
    0,
    height - STATUS_ROWS - composerRows - terminalRows - MIN_TIMELINE_ROWS,
  );
  const popoverRows = Math.min(wantedPopoverRows, popoverBudget);
  const panesRows = Math.max(0, height - STATUS_ROWS - composerRows - popoverRows - terminalRows);

  return { editorRows, composerRows, terminalRows, popoverRows, panesRows };
}
