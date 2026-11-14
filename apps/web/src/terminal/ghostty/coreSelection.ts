import { GHOSTTY_OUT_OF_SPACE, GHOSTTY_SUCCESS, SELECTION_FORMAT_OPTIONS_SIZE } from "./coreLayout";
import { decoder } from "./coreText";
import { GhosttyPointInput, GhosttySelectionRange, GhosttyTerminalCore } from "./core";

export function coreSetSelection(
  core: GhosttyTerminalCore,
  anchor: GhosttyPointInput,
  end: GhosttyPointInput,
) {
  core.ensureActive();
  const selectionLayout = core.runtime.layout("GhosttySelection");
  const gridRefSize = core.runtime.layout("GhosttyGridRef").size;
  const selection = core.runtime.alloc(selectionLayout.size);
  let start = 0;
  let endRef = 0;
  try {
    core.runtime.setField(selection, "GhosttySelection", "size", selectionLayout.size);
    start = core.gridRef(anchor.x, anchor.y, anchor.tag ?? 1);
    endRef = core.gridRef(end.x, end.y, end.tag ?? 1);
    const startField = selectionLayout.fields.start!;
    const endField = selectionLayout.fields.end!;
    core.runtime
      .bytes(selection + startField.offset, startField.size)
      .set(core.runtime.bytes(start, startField.size));
    core.runtime
      .bytes(selection + endField.offset, endField.size)
      .set(core.runtime.bytes(endRef, endField.size));
    core.runtime.call("ghostty_terminal_set", core.terminal, 21, selection);
  } finally {
    core.runtime.free(start, gridRefSize);
    core.runtime.free(endRef, gridRefSize);
    core.runtime.free(selection, selectionLayout.size);
  }
}
export function coreSelectAll(core: GhosttyTerminalCore) {
  core.ensureActive();
  const layout = core.runtime.layout("GhosttySelection");
  const selection = core.runtime.alloc(layout.size);
  try {
    core.runtime.setField(selection, "GhosttySelection", "size", layout.size);
    if (
      core.runtime.call("ghostty_terminal_select_all", core.terminal, selection) !== GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const start = core.pointFromGridRef(selection + layout.fields.start!.offset, 2);
    const end = core.pointFromGridRef(selection + layout.fields.end!.offset, 2);
    if (!start || !end) return null;
    core.runtime.call("ghostty_terminal_set", core.terminal, 21, selection);
    return { start, end };
  } finally {
    core.runtime.free(selection, layout.size);
  }
}
export function coreSelectionRange(core: GhosttyTerminalCore) {
  core.ensureActive();
  const layout = core.runtime.layout("GhosttySelection");
  const selection = core.runtime.alloc(layout.size);
  try {
    core.runtime.setField(selection, "GhosttySelection", "size", layout.size);
    if (
      core.runtime.call("ghostty_terminal_get", core.terminal, 31, selection) !== GHOSTTY_SUCCESS
    ) {
      return null;
    }
    const start = core.pointFromGridRef(selection + layout.fields.start!.offset, 2);
    const end = core.pointFromGridRef(selection + layout.fields.end!.offset, 2);
    return start && end ? { start, end } : null;
  } finally {
    core.runtime.free(selection, layout.size);
  }
}
export function coreSelectWord(core: GhosttyTerminalCore, col: number, row: number) {
  return core.selectAt(
    "GhosttyTerminalSelectWordOptions",
    "ghostty_terminal_select_word",
    col,
    row,
  );
}
export function coreSelectLine(core: GhosttyTerminalCore, col: number, row: number) {
  return core.selectAt(
    "GhosttyTerminalSelectLineOptions",
    "ghostty_terminal_select_line",
    col,
    row,
  );
}
export function coreHyperlinkAt(core: GhosttyTerminalCore, col: number, row: number) {
  core.ensureActive();
  const ref = core.gridRef(col, row);
  const written = core.runtime.call("ghostty_wasm_alloc_usize");
  const sizeResult = core.runtime.call("ghostty_grid_ref_hyperlink_uri", ref, 0, 0, written);
  const outputSize = core.runtime.view(written, 4).getUint32(0, true);
  let hyperlink: string | null = null;
  if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
    const output = core.runtime.alloc(outputSize);
    const result = core.runtime.call(
      "ghostty_grid_ref_hyperlink_uri",
      ref,
      output,
      outputSize,
      written,
    );
    const outputLength = core.runtime.view(written, 4).getUint32(0, true);
    if (result === GHOSTTY_SUCCESS && outputLength > 0) {
      hyperlink = decoder.decode(core.runtime.bytes(output, outputLength));
    }
    core.runtime.free(output, outputSize);
  }
  core.runtime.call("ghostty_wasm_free_usize", written);
  core.runtime.free(ref, core.runtime.layout("GhosttyGridRef").size);
  return hyperlink;
}
export function coreClearSelection(core: GhosttyTerminalCore) {
  core.ensureActive();
  core.runtime.call("ghostty_terminal_set", core.terminal, 21, 0);
}
export function coreSelectionText(core: GhosttyTerminalCore) {
  core.ensureActive();
  const options = core.runtime.alloc(SELECTION_FORMAT_OPTIONS_SIZE);
  const optionsView = core.runtime.view(options, SELECTION_FORMAT_OPTIONS_SIZE);
  optionsView.setUint32(0, SELECTION_FORMAT_OPTIONS_SIZE, true);
  optionsView.setUint32(4, 0, true);
  optionsView.setUint8(8, 1);
  optionsView.setUint8(9, 1);
  optionsView.setUint32(12, 0, true);
  const written = core.runtime.call("ghostty_wasm_alloc_usize");
  const sizeResult = core.runtime.call(
    "ghostty_terminal_selection_format_buf",
    core.terminal,
    options,
    0,
    0,
    written,
  );
  const outputSize = core.runtime.view(written, 4).getUint32(0, true);
  let text = "";
  if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
    const output = core.runtime.alloc(outputSize);
    const result = core.runtime.call(
      "ghostty_terminal_selection_format_buf",
      core.terminal,
      options,
      output,
      outputSize,
      written,
    );
    const outputLength = core.runtime.view(written, 4).getUint32(0, true);
    if (result === GHOSTTY_SUCCESS) {
      text = decoder.decode(core.runtime.bytes(output, outputLength));
    }
    core.runtime.free(output, outputSize);
  }
  core.runtime.call("ghostty_wasm_free_usize", written);
  core.runtime.free(options, SELECTION_FORMAT_OPTIONS_SIZE);
  return text;
}
export function coreViewportPointToScreen(core: GhosttyTerminalCore, col: number, row: number) {
  return core.convertPoint(col, row, 1, 2);
}
export function coreScreenPointToViewport(core: GhosttyTerminalCore, col: number, row: number) {
  return core.convertPoint(col, row, 2, 1);
}
export function coreGridRef(core: GhosttyTerminalCore, col: number, row: number, tag: 1 | 2 = 1) {
  const pointLayout = core.runtime.layout("GhosttyPoint");
  const point = core.runtime.alloc(pointLayout.size);
  core.runtime.setField(point, "GhosttyPoint", "tag", tag);
  const pointValue = pointLayout.fields.value!;
  const valueOffset = pointValue.offset;
  const view = core.runtime.view(point + valueOffset, pointValue.size);
  view.setUint16(0, Math.max(0, col), true);
  view.setUint32(4, Math.max(0, row), true);
  const gridRefSize = core.runtime.layout("GhosttyGridRef").size;
  const gridRef = core.runtime.alloc(gridRefSize);
  core.runtime.setField(gridRef, "GhosttyGridRef", "size", gridRefSize);
  const result = core.runtime.call("ghostty_terminal_grid_ref", core.terminal, point, gridRef);
  core.runtime.free(point, pointLayout.size);
  if (result !== GHOSTTY_SUCCESS) {
    core.runtime.free(gridRef, gridRefSize);
    core.assertSuccess("ghostty_terminal_grid_ref", result);
  }
  return gridRef;
}
export function coreSelectAt(
  core: GhosttyTerminalCore,
  optionsName: "GhosttyTerminalSelectWordOptions" | "GhosttyTerminalSelectLineOptions",
  operation: "ghostty_terminal_select_word" | "ghostty_terminal_select_line",
  col: number,
  row: number,
) {
  core.ensureActive();
  const optionsLayout = core.runtime.layout(optionsName);
  const selectionLayout = core.runtime.layout("GhosttySelection");
  const options = core.runtime.alloc(optionsLayout.size);
  let ref = 0;
  let selection = 0;
  let range: GhosttySelectionRange | null = null;
  try {
    core.runtime.setField(options, optionsName, "size", optionsLayout.size);
    ref = core.gridRef(col, row);
    const refField = optionsLayout.fields.ref!;
    core.runtime
      .bytes(options + refField.offset, refField.size)
      .set(core.runtime.bytes(ref, refField.size));
    selection = core.runtime.alloc(selectionLayout.size);
    core.runtime.setField(selection, "GhosttySelection", "size", selectionLayout.size);
    const result = core.runtime.call(operation, core.terminal, options, selection);
    if (result === GHOSTTY_SUCCESS) {
      const start = selection + selectionLayout.fields.start!.offset;
      const end = selection + selectionLayout.fields.end!.offset;
      const viewportStart = core.pointFromGridRef(start, 1);
      const viewportEnd = core.pointFromGridRef(end, 1);
      const screenStart = core.pointFromGridRef(start, 2);
      const screenEnd = core.pointFromGridRef(end, 2);
      if (viewportStart && viewportEnd && screenStart && screenEnd) {
        range = {
          viewport: { start: viewportStart, end: viewportEnd },
          screen: { start: screenStart, end: screenEnd },
        };
      }
      core.runtime.call("ghostty_terminal_set", core.terminal, 21, selection);
    }
  } finally {
    core.runtime.free(selection, selectionLayout.size);
    core.runtime.free(ref, core.runtime.layout("GhosttyGridRef").size);
    core.runtime.free(options, optionsLayout.size);
  }
  return range;
}
export function corePointFromGridRef(core: GhosttyTerminalCore, ref: number, tag: 1 | 2) {
  const coordinateLayout = core.runtime.layout("GhosttyPointCoordinate");
  const coordinate = core.runtime.alloc(coordinateLayout.size);
  const result = core.runtime.call(
    "ghostty_terminal_point_from_grid_ref",
    core.terminal,
    ref,
    tag,
    coordinate,
  );
  const point =
    result === GHOSTTY_SUCCESS
      ? {
          x: core.runtime.readField(coordinate, "GhosttyPointCoordinate", "x"),
          y: core.runtime.readField(coordinate, "GhosttyPointCoordinate", "y"),
        }
      : null;
  core.runtime.free(coordinate, coordinateLayout.size);
  return point;
}
