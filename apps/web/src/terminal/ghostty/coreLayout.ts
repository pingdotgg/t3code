export const GHOSTTY_SUCCESS = 0;
export const GHOSTTY_OUT_OF_SPACE = -3;
export const MAX_SCROLLBACK_ROWS = 10_000;
// wasm32 GhosttyTerminalSelectionFormatOptions layout at the pinned libghostty-vt revision.
export const SELECTION_FORMAT_OPTIONS_SIZE = 16;
export const PALETTE_BYTES = 256 * 3;

export const RENDER_DATA = {
  cols: 1,
  rows: 2,
  dirty: 3,
  rowIterator: 4,
  background: 5,
  foreground: 6,
  cursor: 7,
  cursorHasValue: 8,
  cursorStyle: 10,
  cursorVisible: 11,
  cursorBlinking: 12,
  cursorInViewport: 14,
  cursorX: 15,
  cursorY: 16,
} as const;

export const ROW_DATA = {
  dirty: 1,
  raw: 2,
  cells: 3,
} as const;

export const CELL_DATA = {
  raw: 1,
  style: 2,
  graphemesLength: 3,
  graphemes: 4,
  background: 5,
  foreground: 6,
  selected: 7,
} as const;

// Optional row_cells_get_multi colors must come last; an unset color stops the query.
export const CELL_QUERY = {
  keys: 0,
  values: 20,
  graphemesLength: 40,
  selected: 44,
  background: 48,
  foreground: 52,
  written: 56,
  size: 60,
} as const;

export const RAW_CELL_DATA = {
  wide: 3,
} as const;

export const GHOSTTY_CELL_WIDE = {
  narrow: 0,
  wide: 1,
  spacerTail: 2,
  spacerHead: 3,
} as const;
