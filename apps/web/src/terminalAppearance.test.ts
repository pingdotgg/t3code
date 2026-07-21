import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyTerminalAppearance,
  AUTOMATIC_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  normalizeTerminalFontFamilyInput,
  normalizeTerminalFontSize,
  normalizeTerminalFontSizeInput,
  resolveTerminalFontFamily,
  type TerminalAppearanceUpdateState,
} from "./terminalAppearance";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeFrameHarness() {
  let nextFrame = 1;
  const frames = new Map<number, () => void>();
  return {
    requestFrame: vi.fn((callback: () => void) => {
      const frame = nextFrame++;
      frames.set(frame, callback);
      return frame;
    }),
    cancelFrame: vi.fn((frame: number) => {
      frames.delete(frame);
    }),
    runAll: () => {
      for (const [frame, callback] of frames) {
        frames.delete(frame);
        callback();
      }
    },
  };
}

function makeTerminal(atBottom: boolean) {
  return {
    buffer: {
      active: {
        viewportY: atBottom ? 20 : 10,
        baseY: 20,
      },
    },
    cols: 120,
    rows: 32,
    options: {
      fontFamily: "old",
      fontSize: 10,
    },
    refresh: vi.fn(),
    scrollToBottom: vi.fn(),
  };
}

describe("resolveTerminalFontFamily", () => {
  it("uses the ordered Nerd Font-compatible automatic stack", () => {
    expect(AUTOMATIC_TERMINAL_FONT_FAMILY).toBe(
      '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font", "Hack Nerd Font", "Noto Mono for Powerline", "SF Mono", "SFMono-Regular", "JetBrains Mono", "Consolas", "Liberation Mono", "Menlo", monospace',
    );
    expect(resolveTerminalFontFamily("")).toBe(AUTOMATIC_TERMINAL_FONT_FAMILY);
    expect(resolveTerminalFontFamily("   ")).toBe(AUTOMATIC_TERMINAL_FONT_FAMILY);
  });

  it("quotes a custom family safely and keeps the automatic fallback", () => {
    expect(resolveTerminalFontFamily('  My "Nerd" \\ Font  ')).toBe(
      `"My \\"Nerd\\" \\\\ Font", ${AUTOMATIC_TERMINAL_FONT_FAMILY}`,
    );
  });
});

describe("normalizeTerminalFontSize", () => {
  it("rounds, clamps, and falls back for invalid input", () => {
    expect(normalizeTerminalFontSize(14)).toBe(14);
    expect(normalizeTerminalFontSize(14.6)).toBe(15);
    expect(normalizeTerminalFontSize(2)).toBe(8);
    expect(normalizeTerminalFontSize(80)).toBe(32);
    expect(normalizeTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("normalizes values committed by the settings inputs", () => {
    expect(normalizeTerminalFontFamilyInput("  MesloLGS NF  ")).toBe("MesloLGS NF");
    expect(normalizeTerminalFontFamilyInput("   ")).toBe("");
    expect(normalizeTerminalFontSizeInput("")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSizeInput("  ")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSizeInput("14.6")).toBe(15);
    expect(normalizeTerminalFontSizeInput("2")).toBe(8);
    expect(normalizeTerminalFontSizeInput("80")).toBe(32);
    expect(normalizeTerminalFontSizeInput("not-a-number")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });
});

describe("applyTerminalAppearance", () => {
  it("mutates the existing terminal and performs the complete update after fonts are ready", async () => {
    const state: TerminalAppearanceUpdateState = { generation: 0 };
    const terminal = makeTerminal(true);
    const fontsReady = deferred();
    const frames = makeFrameHarness();
    const fit = vi.fn();
    const resize = vi.fn();

    applyTerminalAppearance({
      state,
      terminal,
      fontFamily: '"MesloLGS NF", monospace',
      fontSize: 14,
      fontsReady: fontsReady.promise,
      fit,
      resize,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    expect(terminal.options).toEqual({
      fontFamily: '"MesloLGS NF", monospace',
      fontSize: 14,
    });
    expect(fit).not.toHaveBeenCalled();

    fontsReady.resolve();
    await fontsReady.promise;
    await Promise.resolve();
    frames.runAll();

    expect(fit).toHaveBeenCalledOnce();
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 31);
    expect(resize).toHaveBeenCalledWith(120, 32);
  });

  it("samples the scroll position immediately before refitting", async () => {
    const state: TerminalAppearanceUpdateState = { generation: 0 };
    const terminal = makeTerminal(true);
    const fontsReady = deferred();
    const frames = makeFrameHarness();
    const fit = vi.fn();

    applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "updated",
      fontSize: 14,
      fontsReady: fontsReady.promise,
      fit,
      resize: vi.fn(),
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    terminal.buffer.active.viewportY = 10;
    fontsReady.resolve();
    await fontsReady.promise;
    await Promise.resolve();
    frames.runAll();

    expect(fit).toHaveBeenCalledOnce();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("allows only the latest async update to run", async () => {
    const state: TerminalAppearanceUpdateState = { generation: 0 };
    const terminal = makeTerminal(false);
    const firstReady = deferred();
    const secondReady = deferred();
    const frames = makeFrameHarness();
    const firstFit = vi.fn();
    const secondFit = vi.fn();
    const resize = vi.fn();

    applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "first",
      fontSize: 12,
      fontsReady: firstReady.promise,
      fit: firstFit,
      resize,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "second",
      fontSize: 16,
      fontsReady: secondReady.promise,
      fit: secondFit,
      resize,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    firstReady.resolve();
    await firstReady.promise;
    await Promise.resolve();
    frames.runAll();
    expect(firstFit).not.toHaveBeenCalled();
    expect(secondFit).not.toHaveBeenCalled();

    secondReady.resolve();
    await secondReady.promise;
    await Promise.resolve();
    frames.runAll();
    expect(secondFit).toHaveBeenCalledOnce();
    expect(terminal.options).toEqual({ fontFamily: "second", fontSize: 16 });
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 31);
    expect(resize).toHaveBeenCalledWith(120, 32);
  });

  it("makes callbacks no-op after disposal and cancels a scheduled frame", async () => {
    const state: TerminalAppearanceUpdateState = { generation: 0 };
    const terminal = makeTerminal(true);
    const fontsReady = deferred();
    const frames = makeFrameHarness();
    const fit = vi.fn();
    const resize = vi.fn();
    const dispose = applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "disposed",
      fontSize: 13,
      fontsReady: fontsReady.promise,
      fit,
      resize,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    dispose();
    fontsReady.resolve();
    await fontsReady.promise;
    await Promise.resolve();
    frames.runAll();
    expect(frames.requestFrame).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    const disposeScheduled = applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "scheduled",
      fontSize: 14,
      fit,
      resize,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    expect(frames.requestFrame).toHaveBeenCalledOnce();
    disposeScheduled();
    expect(frames.cancelFrame).toHaveBeenCalledOnce();
    frames.runAll();
    expect(fit).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("does nothing when the terminal target becomes stale without appearance disposal", async () => {
    const state: TerminalAppearanceUpdateState = { generation: 0 };
    const terminal = makeTerminal(true);
    const fontsReady = deferred();
    const frames = makeFrameHarness();
    const fit = vi.fn();
    const resize = vi.fn();
    let targetCurrent = true;

    applyTerminalAppearance({
      state,
      terminal,
      fontFamily: "old-target",
      fontSize: 14,
      fontsReady: fontsReady.promise,
      fit,
      resize,
      isTargetCurrent: () => targetCurrent,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    targetCurrent = false;
    fontsReady.resolve();
    await fontsReady.promise;
    await Promise.resolve();
    frames.runAll();

    expect(frames.requestFrame).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });
});
