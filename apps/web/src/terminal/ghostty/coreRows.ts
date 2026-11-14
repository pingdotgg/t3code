import {
  CELL_DATA,
  CELL_QUERY,
  GHOSTTY_OUT_OF_SPACE,
  GHOSTTY_SUCCESS,
  RAW_CELL_DATA,
  ROW_DATA,
} from "./coreLayout";
import { decoder } from "./coreText";
import { GhosttyCell, GhosttyColor, GhosttyTerminalCore } from "./core";

export function coreEncodeOutput(
  core: GhosttyTerminalCore,
  written: number,
  encode: (output: number, outputSize: number) => number,
) {
  const sizeResult = encode(0, 0);
  const outputSize = core.runtime.view(written, 4).getUint32(0, true);
  if (sizeResult === GHOSTTY_SUCCESS && outputSize === 0) return "";
  if (sizeResult !== GHOSTTY_OUT_OF_SPACE || outputSize === 0) return "";

  const output = core.runtime.alloc(outputSize);
  const result = encode(output, outputSize);
  const outputLength = core.runtime.view(written, 4).getUint32(0, true);
  const encoded =
    result === GHOSTTY_SUCCESS ? decoder.decode(core.runtime.bytes(output, outputLength)) : "";
  core.runtime.free(output, outputSize);
  return encoded;
}
export function coreReadRow(
  core: GhosttyTerminalCore,
  iterator: number,
  cols: number,
  defaultForeground: GhosttyColor,
  defaultBackground: GhosttyColor,
) {
  core.assertSuccess(
    "ghostty_render_state_row_get(raw)",
    core.runtime.call("ghostty_render_state_row_get", iterator, ROW_DATA.raw, core.scratch),
  );
  const rawRow = core.runtime.memoryDataView().getBigUint64(core.scratch, true);
  core.runtime.memoryBytes()[core.scratch + 8] = 0;
  core.assertSuccess(
    "ghostty_row_get(wrap continuation)",
    core.runtime.call("ghostty_row_get", rawRow, 2, core.scratch + 8),
  );
  const isWrapContinuation = core.runtime.memoryBytes()[core.scratch + 8] !== 0;
  core.runtime.memoryBytes()[core.scratch + 8] = 0;
  core.assertSuccess(
    "ghostty_row_get(wrap)",
    core.runtime.call("ghostty_row_get", rawRow, 1, core.scratch + 8),
  );
  const wrapsToNext = core.runtime.memoryBytes()[core.scratch + 8] !== 0;

  core.assertSuccess(
    "ghostty_render_state_row_get(cells)",
    core.runtime.call("ghostty_render_state_row_get", iterator, ROW_DATA.cells, core.rowCellsSlot),
  );
  const cellsIterator = core.runtime.readPointer(core.rowCellsSlot);
  const { size: styleSize, fields: styleFields } = core.runtime.layout("GhosttyStyle");
  const cellsNext = core.runtime.fn("ghostty_render_state_row_cells_next");
  const cellsGetMulti = core.runtime.fn("ghostty_render_state_row_cells_get_multi");
  const cells: GhosttyCell[] = [];
  while (cells.length < cols && cellsNext(cellsIterator) !== 0) {
    core.runtime.memoryBytes().fill(0, core.style, core.style + styleSize);
    core.runtime.setField(core.style, "GhosttyStyle", "size", styleSize);
    const result = cellsGetMulti(
      cellsIterator,
      5,
      core.cellQuery + CELL_QUERY.keys,
      core.cellQuery + CELL_QUERY.values,
      core.cellQuery + CELL_QUERY.written,
    );
    const queryView = core.runtime.memoryDataView();
    const written = queryView.getUint32(core.cellQuery + CELL_QUERY.written, true);
    if (written < 3) core.assertSuccess("ghostty_render_state_row_cells_get_multi", result);
    const graphemeLength = queryView.getUint32(core.cellQuery + CELL_QUERY.graphemesLength, true);
    const selected = queryView.getUint8(core.cellQuery + CELL_QUERY.selected) !== 0;
    let background =
      written >= 4 ? core.readColor(core.cellQuery + CELL_QUERY.background) : defaultBackground;
    let foreground =
      written === 5
        ? core.readColor(core.cellQuery + CELL_QUERY.foreground)
        : written === 3
          ? core.getCellColor(cellsIterator, CELL_DATA.foreground, defaultForeground)
          : defaultForeground;
    let text = "";
    if (graphemeLength > 0) {
      const bufferSize = graphemeLength * 4;
      if (bufferSize > core.graphemeCapacity) {
        const capacity = Math.max(bufferSize, core.graphemeCapacity * 2);
        const buffer = core.runtime.alloc(capacity);
        core.runtime.free(core.graphemes, core.graphemeCapacity);
        core.graphemes = buffer;
        core.graphemeCapacity = capacity;
      }
      if (
        core.runtime.call(
          "ghostty_render_state_row_cells_get",
          cellsIterator,
          CELL_DATA.graphemes,
          core.graphemes,
        ) === GHOSTTY_SUCCESS
      ) {
        // Byte allocations need not be 4-byte aligned; use DataView instead of Uint32Array.
        text = ghosttyCellText(core.runtime.memoryDataView(), graphemeLength, core.graphemes);
      }
    }
    let wide = 0;
    // A wrap spacer in the final column can follow a spacer tail.
    if (text.length === 0 && (cells.at(-1)?.text.length || cells.length === cols - 1)) {
      core.assertSuccess(
        "ghostty_render_state_row_cells_get(raw)",
        core.runtime.call(
          "ghostty_render_state_row_cells_get",
          cellsIterator,
          CELL_DATA.raw,
          core.scratch,
        ),
      );
      const rawCell = core.runtime.memoryDataView().getBigUint64(core.scratch, true);
      core.runtime.memoryDataView().setUint32(core.scratch + 8, 0, true);
      core.assertSuccess(
        "ghostty_cell_get(wide)",
        core.runtime.call("ghostty_cell_get", rawCell, RAW_CELL_DATA.wide, core.scratch + 8),
      );
      wide = core.runtime.memoryDataView().getUint32(core.scratch + 8, true);
    }
    // Read the style after allocation and ABI calls, which can grow WASM memory.
    const styleView = core.runtime.memoryDataView();
    if (styleView.getUint8(core.style + styleFields.inverse!.offset) !== 0) {
      [foreground, background] = [background, foreground];
    }
    if (styleView.getUint8(core.style + styleFields.faint!.offset) !== 0) {
      foreground = blend(foreground, background);
    }
    cells.push({
      text,
      wide,
      foreground,
      background,
      bold: styleView.getUint8(core.style + styleFields.bold!.offset) !== 0,
      italic: styleView.getUint8(core.style + styleFields.italic!.offset) !== 0,
      invisible: styleView.getUint8(core.style + styleFields.invisible!.offset) !== 0,
      strikethrough: styleView.getUint8(core.style + styleFields.strikethrough!.offset) !== 0,
      overline: styleView.getUint8(core.style + styleFields.overline!.offset) !== 0,
      underline: styleView.getInt32(core.style + styleFields.underline!.offset, true) !== 0,
      selected,
    });
  }
  while (cells.length < cols) cells.push(core.emptyCell(defaultForeground, defaultBackground));
  return {
    cells,
    text: cells
      .map((cell) => cell.text || " ")
      .join("")
      .trimEnd(),
    isWrapContinuation,
    wrapsToNext,
  };
}
export function coreGetU16(core: GhosttyTerminalCore, data: number) {
  core.runtime.memoryDataView().setUint16(core.scratch, 0, true);
  core.assertSuccess(
    "ghostty_render_state_get",
    core.runtime.call("ghostty_render_state_get", core.renderState, data, core.scratch),
  );
  return core.runtime.memoryDataView().getUint16(core.scratch, true);
}
export function coreGetU32(core: GhosttyTerminalCore, data: number) {
  core.runtime.memoryDataView().setUint32(core.scratch, 0, true);
  core.assertSuccess(
    "ghostty_render_state_get",
    core.runtime.call("ghostty_render_state_get", core.renderState, data, core.scratch),
  );
  return core.runtime.memoryDataView().getUint32(core.scratch, true);
}
export function coreGetBool(core: GhosttyTerminalCore, data: number) {
  core.runtime.memoryBytes()[core.scratch] = 0;
  core.assertSuccess(
    "ghostty_render_state_get",
    core.runtime.call("ghostty_render_state_get", core.renderState, data, core.scratch),
  );
  return core.runtime.memoryBytes()[core.scratch] !== 0;
}
export function coreGetColor(core: GhosttyTerminalCore, data: number, fallback: GhosttyColor) {
  core.runtime.memoryBytes().fill(0, core.scratch, core.scratch + 3);
  const result = core.runtime.call(
    "ghostty_render_state_get",
    core.renderState,
    data,
    core.scratch,
  );
  return result === GHOSTTY_SUCCESS ? core.readColor(core.scratch) : fallback;
}
export function coreGetRowBool(core: GhosttyTerminalCore, iterator: number, data: number) {
  core.runtime.memoryBytes()[core.scratch] = 0;
  return (
    core.runtime.call("ghostty_render_state_row_get", iterator, data, core.scratch) ===
      GHOSTTY_SUCCESS && core.runtime.memoryBytes()[core.scratch] !== 0
  );
}
export function coreGetCellColor(
  core: GhosttyTerminalCore,
  iterator: number,
  data: number,
  fallback: GhosttyColor,
) {
  core.runtime.memoryBytes().fill(0, core.scratch, core.scratch + 3);
  const result = core.runtime.call(
    "ghostty_render_state_row_cells_get",
    iterator,
    data,
    core.scratch,
  );
  return result === GHOSTTY_SUCCESS ? core.readColor(core.scratch) : fallback;
}
export function coreReadColor(core: GhosttyTerminalCore, pointer: number) {
  const view = core.runtime.memoryDataView();
  return {
    r: view.getUint8(pointer),
    g: view.getUint8(pointer + 1),
    b: view.getUint8(pointer + 2),
  };
}
export function coreEmptyCell(
  core: GhosttyTerminalCore,
  foreground: GhosttyColor,
  background: GhosttyColor,
) {
  return {
    text: "",
    wide: 0,
    foreground,
    background,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false,
  };
}
export function coreAssertSuccess(core: GhosttyTerminalCore, operation: string, result: number) {
  if (result !== GHOSTTY_SUCCESS) throw new Error(`${operation} failed with result ${result}`);
}
export function coreEnsureActive(core: GhosttyTerminalCore) {
  if (core.disposed) throw new Error("libghostty-vt terminal has been disposed");
}

export function blend(foreground: GhosttyColor, background: GhosttyColor): GhosttyColor {
  const channel = (front: number, back: number) => Math.floor((front * 155 + back * 100) / 255);
  return {
    r: channel(foreground.r, background.r),
    g: channel(foreground.g, background.g),
    b: channel(foreground.b, background.b),
  };
}

export function ghosttyCellText(
  codepointView: DataView,
  graphemeLength: number,
  byteOffset = 0,
): string {
  if (graphemeLength === 1) return String.fromCodePoint(codepointView.getUint32(byteOffset, true));
  const CHUNK_SIZE = 4_096;
  let text = "";
  for (let start = 0; start < graphemeLength; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, graphemeLength - start);
    const codes = new Array<number>(count);
    for (let index = 0; index < count; index += 1) {
      codes[index] = codepointView.getUint32(byteOffset + (start + index) * 4, true);
    }
    text += String.fromCodePoint(...codes);
  }
  return text;
}
