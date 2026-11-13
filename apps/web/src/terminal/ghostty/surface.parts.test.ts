import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";
import { synchronizeTerminalSession } from "../../components/ThreadTerminalDrawer";

import { GhosttyTerminalCore, type GhosttyCell, type GhosttyRow } from "./core";
import {
  advanceTerminalSelectionClickSequence,
  applyTerminalCopyEvent,
  clearPrimedTerminalCopyInput,
  isTerminalCompositionKey,
  isTerminalCopyShortcut,
  primeTerminalCopyInput,
  resolveTerminalMouseData,
  terminalLinkAtPositionWithRange,
  terminalContentOriginY,
  terminalSelectionAutoscrollRows,
  terminalWheelDeltaRows,
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "./surface";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

export const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

describe("terminalLinkAtPositionWithRange", () => {
  it.each([
    { text: "https://example.com/日本", cols: 80, end: { x: 23, y: 0 } },
    { text: "src/日本/main.ts:3:1", cols: 80, end: { x: 19, y: 0 } },
    { text: "https://example.com/🙂", cols: 80, end: { x: 21, y: 0 } },
    { text: "https://example.com/日本", cols: 23, end: { x: 1, y: 1 } },
  ])("keeps every cell of $text clickable at $cols columns", async ({ text, cols, end }) => {
    const core = await GhosttyTerminalCore.create(
      cols,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      () => {},
    );
    try {
      core.write(text + " next");
      const rows = core.snapshot().rowData;
      for (let y = 0; y <= end.y; y += 1) {
        const lastColumn = y === end.y ? end.x : cols - 2;
        for (let x = 0; x <= lastColumn; x += 1) {
          expect(terminalLinkAtPositionWithRange(rows, y, x)).toEqual({
            text,
            range: { start: { x: 0, y: 0 }, end },
          });
        }
      }
      expect(terminalLinkAtPositionWithRange(rows, end.y, end.x + 1)).toBeNull();
    } finally {
      core.dispose();
    }
  });

  it("activates a wrapped quoted Windows path from its spaces and position suffix", () => {
    const row = (text: string, isWrapContinuation: boolean): GhosttyRow => ({
      cells: Array.from(text, (character) => cell(character)),
      text,
      isWrapContinuation,
      wrapsToNext: false,
    });
    const first = String.raw`"C:\Users\Jane `;
    const second = String.raw`Doe\index.ts":12:7`;
    const rows = [row(first, false), row(second, true)];
    const expected = {
      text: String.raw`C:\Users\Jane Doe\index.ts:12:7`,
      range: { start: { x: 1, y: 0 }, end: { x: second.length - 1, y: 1 } },
    };
    expect(terminalLinkAtPositionWithRange(rows, 0, first.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 1, second.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 0, 0)).toBeNull();
  });

  it("maps terminal cells to UTF-16 offsets after a wide emoji", () => {
    const cells = [
      cell("🙂"),
      cell(""),
      ...Array.from("https://t3.codes", (character) => cell(character)),
    ];
    const row: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || " ")
        .join("")
        .trimEnd(),
      isWrapContinuation: false,
      wrapsToNext: false,
    };

    expect(terminalLinkAtPositionWithRange([row], 0, 2)?.text).toBe("https://t3.codes");
    expect(terminalLinkAtPositionWithRange([row], 0, cells.length - 1)?.text).toBe(
      "https://t3.codes",
    );
    expect(terminalLinkAtPositionWithRange([row], 0, 0)).toBeNull();
    expect(terminalLinkAtPositionWithRange([row], 0, 8)?.range).toEqual({
      start: { x: 2, y: 0 },
      end: { x: cells.length - 1, y: 0 },
    });
  });

  it("uses shared path matching and reconstructs soft-wrapped links", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    const rows = [
      row("https://example.", false),
      row("com/reference", true),
      row("~/project/file", false),
      row("C:\\repo\\file.ts", false),
      row("PS C:\\repo\\dir 1", false, true),
      row("\\test> ", true),
    ];

    expect(terminalLinkAtPositionWithRange(rows, 0, 8)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 2, 2)?.text).toBe("~/project/file");
    expect(terminalLinkAtPositionWithRange(rows, 3, 4)?.text).toBe("C:\\repo\\file.ts");
    expect(terminalLinkAtPositionWithRange(rows, 4, 13)).toEqual({
      text: "C:\\repo\\dir 1\\test",
      range: { start: { x: 3, y: 4 }, end: { x: 4, y: 5 } },
    });
    expect(terminalLinkAtPositionWithRange(rows, 5, 2)?.text).toBe("C:\\repo\\dir 1\\test");
    expect(terminalLinkAtPositionWithRange(rows, 5, 5)).toBeNull();
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)).toEqual({
      text: "https://example.com/reference",
      range: {
        start: { x: 0, y: 0 },
        end: { x: 12, y: 1 },
      },
    });
  });

  it("refuses links truncated at the viewport edges instead of mis-resolving", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    const headCut = [row("ple.com/missing", true), row("head", true)];
    expect(terminalLinkAtPositionWithRange(headCut, 0, 4)).toBeNull();
    const tailCut = [row("https://t3.codes", false, true)];
    expect(terminalLinkAtPositionWithRange(tailCut, 0, 8)).toBeNull();
    const complete = [row("https://t3.codes", false), row("", false)];
    expect(terminalLinkAtPositionWithRange(complete, 0, 8)?.text).toBe("https://t3.codes");
    const wideFull: GhosttyRow = {
      cells: [
        { ...cell("🙂"), wide: 1 },
        { ...cell(""), wide: 2 },
        ...Array.from("https://t3.code", (character) => cell(character)),
      ],
      text: "🙂 https://t3.code",
      isWrapContinuation: false,
      wrapsToNext: true,
    };
    expect(terminalLinkAtPositionWithRange([wideFull], 0, 8)).toBeNull();
    const unwrittenTail: GhosttyRow = {
      cells: [
        ...Array.from("https://t3.codes", (character) => cell(character)),
        cell(""),
        cell(""),
      ],
      text: "https://t3.codes",
      isWrapContinuation: false,
      wrapsToNext: false,
    };
    expect(terminalLinkAtPositionWithRange([unwrittenTail], 0, 8)?.text).toBe("https://t3.codes");
  });
});

describe("isTerminalCopyShortcut", () => {
  const event = (overrides: Partial<Parameters<typeof isTerminalCopyShortcut>[0]> = {}) => ({
    ctrlKey: false,
    key: "c",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("keeps Ctrl+C available for SIGINT on macOS", () => {
    expect(isTerminalCopyShortcut(event({ ctrlKey: true }), "MacIntel")).toBe(false);
    expect(isTerminalCopyShortcut(event({ metaKey: true }), "MacIntel")).toBe(true);
  });

  it("uses the produced character instead of the physical key position", () => {
    expect(isTerminalCopyShortcut(event({ key: "C", metaKey: true }), "MacIntel")).toBe(true);
    expect(isTerminalCopyShortcut(event({ key: "j", metaKey: true }), "MacIntel")).toBe(false);
  });
});

describe("applyTerminalCopyEvent", () => {
  // regression: #7678 copying a terminal selection produced a blank clipboard
  it("leaves the writeText fallback alive when clipboardData is missing", () => {
    // Electron menu Copy often omits clipboardData.
    expect(applyTerminalCopyEvent("ls -la", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(applyTerminalCopyEvent("", { setData: vi.fn() })).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
  });

  it("primes the current selection before a copy event with no clipboardData", () => {
    const input = {
      value: "stale",
      selectionStart: 0,
      selectionEnd: 0,
      select() {
        this.selectionStart = 0;
        this.selectionEnd = this.value.length;
      },
    };
    primeTerminalCopyInput(input, "git status");
    expect(applyTerminalCopyEvent("git status", null)).toEqual({
      preventDefault: false,
      claimWriteFallback: false,
    });
    expect(input.value).toBe("git status");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(10);
  });
});

describe("primeTerminalCopyInput", () => {
  it("does not wipe an IME candidate that replaced the primed copy", () => {
    const input = { value: "", select() {} };
    primeTerminalCopyInput(input, "git status");
    input.value = "あ";
    clearPrimedTerminalCopyInput(input, "git status");
    expect(input.value).toBe("あ");
  });
});

describe("isTerminalCompositionKey", () => {
  const event = (
    overrides: Partial<Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">> = {},
  ) => ({
    isComposing: false,
    key: "a",
    keyCode: 65,
    ...overrides,
  });

  it("treats in-progress IME keydowns as composition so the copy primer cannot wipe them", () => {
    expect(isTerminalCompositionKey(event({ isComposing: true }), false)).toBe(true);
    expect(isTerminalCompositionKey(event(), true)).toBe(true);
    expect(isTerminalCompositionKey(event({ key: "Process" }), false)).toBe(true);
    expect(isTerminalCompositionKey(event({ keyCode: 229 }), false)).toBe(true);
  });
});

describe("application mouse reporting", () => {
  it("drops repeated motion reports until another mouse action resets the cell", () => {
    const first = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", "");
    expect(first).toEqual({ send: true, nextMotionData: "\u001b[<35;8;4M" });

    const duplicate = resolveTerminalMouseData("motion", "\u001b[<35;8;4M", first.nextMotionData);
    expect(duplicate).toEqual({ send: false, nextMotionData: "\u001b[<35;8;4M" });

    const press = resolveTerminalMouseData("press", "\u001b[<0;8;4M", duplicate.nextMotionData);
    expect(press).toEqual({ send: true, nextMotionData: "" });

    expect(resolveTerminalMouseData("motion", "\u001b[<35;8;4M", press.nextMotionData)).toEqual({
      send: true,
      nextMotionData: "\u001b[<35;8;4M",
    });
  });
});

describe("terminalContentOriginY", () => {
  it("keeps the prompt stationary while a drag crosses row boundaries", () => {
    for (let height = 88; height < 104; height += 1) {
      const rows = Math.max(1, Math.floor((height - 8) / 16));
      const origin = terminalContentOriginY(height, 4, rows, 16, true);
      expect(origin + rows * 16).toBe(height - 4);
    }
  });
});

describe("terminalWheelDeltaRows", () => {
  it("accumulates fractional pixel deltas across events", () => {
    let remainder = 0;
    let scrolled = 0;
    for (let index = 0; index < 4; index += 1) {
      const result = terminalWheelDeltaRows({ deltaY: 5, deltaMode: 0 }, 16, 24, remainder);
      remainder = result.remainder;
      scrolled += result.rows;
    }
    expect(scrolled).toBe(1);
    expect(remainder).toBeCloseTo(4 / 16);
  });
});

// regression: #19492 drag selection scrolled one row per tick however far past the edge
describe("terminalSelectionAutoscrollRows", () => {
  it("scrolls more rows per tick the farther the pointer is past an edge", () => {
    const top = 100;
    const bottom = 500;
    expect(terminalSelectionAutoscrollRows(300, top, bottom)).toBe(0);
    expect(terminalSelectionAutoscrollRows(99, top, bottom)).toBe(-1);
    expect(terminalSelectionAutoscrollRows(75, top, bottom)).toBe(-8);
    expect(terminalSelectionAutoscrollRows(501, top, bottom)).toBe(1);
    expect(terminalSelectionAutoscrollRows(525, top, bottom)).toBe(8);
    expect(terminalSelectionAutoscrollRows(550, top, bottom)).toBe(15);
    expect(terminalSelectionAutoscrollRows(2_000, top, bottom)).toBe(15);
  });
});

describe("advanceTerminalSelectionClickSequence", () => {
  it("recognizes stationary double and triple pointer presses without PointerEvent.detail", () => {
    const first = advanceTerminalSelectionClickSequence(null, {
      clientX: 20,
      clientY: 30,
      timeStamp: 1_000,
    });
    const second = advanceTerminalSelectionClickSequence(first, {
      clientX: 22,
      clientY: 29,
      timeStamp: 1_200,
    });
    const third = advanceTerminalSelectionClickSequence(second, {
      clientX: 21,
      clientY: 31,
      timeStamp: 1_400,
    });

    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
  });
});

