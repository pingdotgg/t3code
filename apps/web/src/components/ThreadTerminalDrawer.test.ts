import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";

import {
  shouldHandleTerminalExit,
  synchronizeTerminalOutput,
  synchronizeTerminalSession,
  terminalClipboardShortcutAction,
} from "./ThreadTerminalDrawer";

describe("terminal selection actions", () => {
  it("leaves only Alt-free native clipboard chords to the surface", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
      key,
      code: `Key${key.toUpperCase()}`,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...modifiers,
    });
    const action = terminalClipboardShortcutAction;

    expect(action("terminal.copy", key("c", { ctrlKey: true }), true)).toBe("native");
    expect(action("terminal.copy", key("c", { ctrlKey: true }), false)).toBe("copy");
    expect(action("terminal.copy", key("c", { ctrlKey: true, altKey: true }), true)).toBe("copy");
    expect(action("terminal.copy", key("c", { metaKey: true }), true)).toBe("copy");
    expect(action("terminal.paste", key("v", { ctrlKey: true, shiftKey: true }), false)).toBe(
      "native",
    );
    expect(
      action("terminal.paste", key("v", { ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBe("paste");
    expect(action("terminal.paste", key("v", { metaKey: true }), false)).toBe("paste");
    const insert = (modifiers: Partial<KeyboardEvent>) => ({
      ...key("Insert", modifiers),
      code: "Insert",
    });
    expect(action("terminal.copy", insert({ ctrlKey: true }), true)).toBe("native");
    expect(action("terminal.copy", insert({ ctrlKey: true, altKey: true }), true)).toBe("copy");
    expect(action("terminal.paste", insert({ shiftKey: true }), false)).toBe("native");
    expect(action("terminal.paste", insert({ shiftKey: true, altKey: true }), false)).toBe("paste");
    expect(action("terminal.new", key("c", { ctrlKey: true }), true)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false, 1)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false, 1)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true, 1)).toBe(false);
  });
});

it("retains visible output and selection until a replacement subscription receives its snapshot", () => {
  const terminal = {
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    getSelection: vi.fn(() => "selected"),
    getSelectionCellCount: vi.fn(() => 8),
    clearSelection: vi.fn(),
  };
  const snapshot = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "host output",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot,
  });
  const cursor = synchronizeTerminalOutput(terminal, attached, INITIAL_TERMINAL_OUTPUT_CURSOR);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output");
  terminal.resetAndWrite.mockClear();
  terminal.clearSelection.mockClear();

  const pending = combineTerminalSessionState(
    { ...snapshot, hasRunningSubprocess: false },
    EMPTY_TERMINAL_BUFFER_STATE,
  );
  expect(pending.status).toBe("running");
  expect(synchronizeTerminalOutput(terminal, pending, cursor)).toBe(cursor);
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.write).not.toHaveBeenCalled();
  expect(terminal.clearSelection).not.toHaveBeenCalled();

  const observed = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot: { ...snapshot, history: "host output\nobserved output" },
  });
  const observedCursor = synchronizeTerminalOutput(terminal, observed, cursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output\nobserved output");

  const cleared = applyTerminalAttachStreamEvent(observed, {
    type: "cleared",
    threadId: "thread",
    terminalId: "term-1",
  });
  terminal.resetAndWrite.mockClear();
  synchronizeTerminalOutput(terminal, cleared, observedCursor);
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenLastCalledWith("\u001b[H\u001b[2J\u001b[3J");
});

it("reports an attach failure that leaves the output unchanged", () => {
  const terminal = {
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    getSelection: vi.fn(() => "selected"),
    getSelectionCellCount: vi.fn(() => 8),
    clearSelection: vi.fn(),
  };
  const previous = { ...EMPTY_TERMINAL_BUFFER_STATE, error: null };
  const failed = { ...previous, error: "Terminal attach failed" };

  expect(
    synchronizeTerminalSession(terminal, previous, failed, INITIAL_TERMINAL_OUTPUT_CURSOR),
  ).toBe(INITIAL_TERMINAL_OUTPUT_CURSOR);
  expect(terminal.write).toHaveBeenCalledWith("\r\n[terminal] Terminal attach failed\r\n");
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.getSelection).not.toHaveBeenCalled();
  expect(terminal.getSelectionCellCount).not.toHaveBeenCalled();
  expect(terminal.clearSelection).not.toHaveBeenCalled();

  const snapshot = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "error" as const,
    pid: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "Terminal",
    updatedAt: "2026-11-15T00:00:00.000Z",
    error: "Terminal attach failed",
  };
  const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot,
  });
  const cursor = synchronizeTerminalSession(
    terminal,
    failed,
    attached,
    INITIAL_TERMINAL_OUTPUT_CURSOR,
  );
  terminal.write.mockClear();
  const reconnected = applyTerminalAttachStreamEvent(attached, { type: "snapshot", snapshot });
  synchronizeTerminalSession(terminal, attached, reconnected, cursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("");
  expect(terminal.write).toHaveBeenCalledWith("\r\n[terminal] Terminal attach failed\r\n");
});
