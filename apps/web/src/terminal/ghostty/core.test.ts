import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GHOSTTY_CELL_WIDE, GhosttyTerminalCore, ghosttyCellText } from "./core";
import { loadGhosttyRuntime } from "./runtime";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

function codepointView(codepoints: ReadonlyArray<number>): DataView {
  const view = new DataView(new ArrayBuffer(codepoints.length * 4));
  codepoints.forEach((codepoint, index) => view.setUint32(index * 4, codepoint, true));
  return view;
}

describe("ghosttyCellText", () => {
  it("converts oversized grapheme clusters without hitting engine spread limits", () => {
    // A program printing one base character followed by a huge run of
    // combining marks packs the whole cluster into one cell; spreading that
    // many arguments into String.fromCodePoint once overflows the call stack.
    const graphemeLength = 130_000;
    const view = new DataView(new ArrayBuffer(graphemeLength * 4));
    for (let index = 0; index < graphemeLength; index += 1) {
      view.setUint32(index * 4, index === 0 ? "a".codePointAt(0)! : 0x301, true);
    }
    const text = ghosttyCellText(view, graphemeLength);
    expect(text.length).toBe(graphemeLength);
    expect(text.codePointAt(0)).toBe("a".codePointAt(0));
    expect(text.codePointAt(1)).toBe(0x301);
    expect(text.codePointAt(graphemeLength - 1)).toBe(0x301);
  });

  it("converts small clusters including astral codepoints", () => {
    const text = ghosttyCellText(codepointView([0x1f642, 0x20e3]), 2);
    expect([...text]).toEqual(["\u{1F642}", "\u{20E3}"]);
  });

  it("converts a single astral codepoint", () => {
    expect(ghosttyCellText(codepointView([0x1f642]), 1)).toBe("🙂");
  });

  it("returns an empty string for empty cells", () => {
    expect(ghosttyCellText(codepointView([]), 0)).toBe("");
  });
});

describe("GhosttyTerminalCore snapshots", () => {
  const cores = new Set<GhosttyTerminalCore>();

  async function createCore() {
    const core = await GhosttyTerminalCore.create(
      12,
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
    cores.add(core);
    return core;
  }

  afterEach(() => {
    for (const core of cores) core.dispose();
    cores.clear();
    vi.restoreAllMocks();
  });

  it("preserves styles, wide cells, and selection after shared memory grows", async () => {
    const core = await createCore();
    const runtime = await loadGhosttyRuntime();
    const grapheme = `e${"\u0301".repeat(64)}`;
    core.write(`\x1b[1;3;4;8;9;53;38;2;123;45;67;48;2;9;8;7m${grapheme}\x1b[0m界🙂`);
    const cells = core.snapshot().rowData[0]!.cells;
    expect(cells[0]).toEqual({
      text: grapheme,
      wide: 0,
      foreground: { r: 123, g: 45, b: 67 },
      background: { r: 9, g: 8, b: 7 },
      bold: true,
      italic: true,
      invisible: true,
      strikethrough: true,
      overline: true,
      underline: true,
      selected: false,
    });
    expect(cells.slice(1, 5).map(({ text, wide }) => ({ text, wide }))).toEqual([
      { text: "界", wide: 0 },
      { text: "", wide: GHOSTTY_CELL_WIDE.spacerTail },
      { text: "🙂", wide: 0 },
      { text: "", wide: GHOSTTY_CELL_WIDE.spacerTail },
    ]);

    runtime.memory.grow(1);
    core.setSelection({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual({ ...cells[0], selected: true });
    core.clearSelection();
    expect(core.snapshot().rowData[0]!.cells[0]).toEqual(cells[0]);

    core.resetAndWrite("\x1b[2;7;38;2;40;100;200;48;2;12;34;56mC\x1b[0m");
    expect(core.snapshot().rowData[0]!.cells[0]).toMatchObject({
      text: "C",
      foreground: { r: 22, g: 59, b: 112 },
      background: { r: 40, g: 100, b: 200 },
      bold: false,
      underline: false,
      selected: false,
    });
  });

  it("reuses a grown grapheme buffer and releases it on disposal", async () => {
    const core = await createCore();
    const runtime = await loadGhosttyRuntime();
    core.write("ASCII");
    core.snapshot();

    const grapheme = `z${"\u0301".repeat(256)}`;
    core.resetAndWrite(`${grapheme}X`);
    const alloc = vi.spyOn(runtime, "alloc");
    const free = vi.spyOn(runtime, "free");
    expect(
      core
        .snapshot()
        .rowData[0]!.cells.slice(0, 2)
        .map((cell) => cell.text),
    ).toEqual([grapheme, "X"]);
    expect(alloc).toHaveBeenCalledTimes(1);
    const allocation = alloc.mock.results[0]!;
    if (allocation.type !== "return") throw new Error("Grapheme allocation did not return");
    const buffer = allocation.value;
    const capacity = alloc.mock.calls[0]![0];

    core.write("\rQ\u0301");
    alloc.mockClear();
    expect(core.snapshot().rowData[0]!.cells[0]!.text).toBe("Q\u0301");
    expect(alloc).not.toHaveBeenCalled();
    core.dispose();
    expect(free).toHaveBeenCalledWith(buffer, capacity);
  });
});
