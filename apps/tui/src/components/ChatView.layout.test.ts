import { describe, expect, it } from "bun:test";

import {
  COMPOSER_MAX_EDITOR_ROWS,
  COMPOSER_MIN_EDITOR_ROWS,
  countWrappedComposerLines,
  LIST_PANE_WIDTH,
  MIN_TERMINAL_DRAWER_ROWS,
  resolveChatColumnLayout,
  resolveChatVerticalLayout,
  resolveSidebarListViewport,
  STATUS_ROWS,
} from "./ChatView.layout.ts";

describe("responsive chat layout", () => {
  it("Given enough width, the projects sidebar remains docked at full height", () => {
    const layout = resolveChatColumnLayout(120, false);
    expect(layout.sidebarVisible).toBe(true);
    expect(layout.listWidth).toBe(LIST_PANE_WIDTH);
    expect(layout.listWidth + layout.mainWidth).toBe(120);
  });

  it("Given a narrow terminal, the sidebar auto-collapses before squeezing the conversation", () => {
    const layout = resolveChatColumnLayout(72, false);
    expect(layout.sidebarVisible).toBe(false);
    expect(layout.chatWidth).toBe(72);
  });

  it("Given a narrow main column, an open detail panel replaces the conversation", () => {
    const layout = resolveChatColumnLayout(100, true);
    expect(layout.rightPanelAsMain).toBe(true);
    expect(layout.rightWidth).toBe(0);
  });

  it("Given a full-height sidebar, its item window reserves every chrome row", () => {
    expect(resolveSidebarListViewport(28)).toBe(18);
  });
});

describe("composer and terminal row allocation", () => {
  it("Given an empty prompt, the editor starts at the web UI's multiline height", () => {
    const desired = Math.max(COMPOSER_MIN_EDITOR_ROWS, countWrappedComposerLines("", 70));
    expect(desired).toBe(3);
  });

  it("Given a long wrapped prompt, the editor caps and scrolls internally", () => {
    const desired = Math.max(
      COMPOSER_MIN_EDITOR_ROWS,
      countWrappedComposerLines("word ".repeat(500), 40),
    );
    const layout = resolveChatVerticalLayout({
      terminalHeight: 40,
      desiredEditorRows: desired,
      composerChromeRows: 4,
      terminalOpen: false,
      preferredTerminalRows: 16,
      wantedPopoverRows: 0,
    });
    expect(layout.editorRows).toBe(COMPOSER_MAX_EDITOR_ROWS);
  });

  it("Given a long prompt and an open terminal, every row stays in bounds and the terminal remains usable", () => {
    const height = 28;
    const layout = resolveChatVerticalLayout({
      terminalHeight: height,
      desiredEditorRows: 100,
      composerChromeRows: 5,
      terminalOpen: true,
      preferredTerminalRows: 11,
      wantedPopoverRows: 0,
    });
    expect(layout.terminalRows).toBeGreaterThanOrEqual(MIN_TERMINAL_DRAWER_ROWS);
    expect(
      layout.panesRows +
        layout.composerRows +
        layout.terminalRows +
        layout.popoverRows +
        STATUS_ROWS,
    ).toBe(height);
  });

  it("Given a popover above an open terminal, the terminal keeps its preferred size", () => {
    const layout = resolveChatVerticalLayout({
      terminalHeight: 28,
      desiredEditorRows: 1,
      composerChromeRows: 5,
      terminalOpen: true,
      preferredTerminalRows: 11,
      wantedPopoverRows: 20,
    });
    expect(layout.terminalRows).toBe(11);
    expect(layout.popoverRows).toBeGreaterThan(0);
  });
});
