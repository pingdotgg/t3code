#include <ghostty/vt.h>
#include <stdint.h>

// Browser snapshot ABI: an 8-byte row header, cols * 24-byte cell records,
// then UTF-32 graphemes. Offsets are relative to the caller-owned output.
// The caller provides a 4-byte-aligned buffer and retries OUT_OF_SPACE with
// *written bytes. This helper never clears dirty state or owns Ghostty handles.
static void put_u32(uint8_t *out, uint32_t value) {
  out[0] = value;
  out[1] = value >> 8;
  out[2] = value >> 16;
  out[3] = value >> 24;
}

__attribute__((visibility("default")))
GhosttyResult t3_ghostty_pack_row(GhosttyRenderStateRowIterator row,
                                GhosttyRenderStateRowCells cells,
                                uint32_t cols, uint8_t *out, uint32_t capacity,
                                uint32_t *written) {
  GhosttyRow raw_row = 0;
  GhosttyResult result = ghostty_render_state_row_get(
      row, GHOSTTY_RENDER_STATE_ROW_DATA_RAW, &raw_row);
  if (result != GHOSTTY_SUCCESS) return result;
  bool wrap = false, continuation = false;
  result = ghostty_row_get(raw_row, GHOSTTY_ROW_DATA_WRAP, &wrap);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_row_get(raw_row, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &continuation);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_render_state_row_get(row, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &cells);
  if (result != GHOSTTY_SUCCESS) return result;

  uint32_t required = 8 + cols * 24;
  uint32_t count = 0;
  uint32_t previous_length = 0;
  while (count < cols && ghostty_render_state_row_cells_next(cells)) {
    uint32_t length = 0;
    result = ghostty_render_state_row_cells_get(
        cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
    if (result != GHOSTTY_SUCCESS) return result;
    if (length > (UINT32_MAX - required) / 4) return GHOSTTY_OUT_OF_MEMORY;
    uint32_t text_offset = required;
    required += length * 4;
    if (required <= capacity) {
      GhosttyStyle style = {.size = sizeof(GhosttyStyle)};
      result = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
      if (result != GHOSTTY_SUCCESS) return result;
      GhosttyColorRgb fg = {0}, bg = {0};
      bool has_fg = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &fg) == GHOSTTY_SUCCESS;
      bool has_bg = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bg) == GHOSTTY_SUCCESS;
      bool selected = false;
      result = ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, &selected);
      if (result != GHOSTTY_SUCCESS) return result;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      if (!length && previous_length) {
        GhosttyCell raw_cell = 0;
        result = ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw_cell);
        if (result != GHOSTTY_SUCCESS) return result;
        result = ghostty_cell_get(raw_cell, GHOSTTY_CELL_DATA_WIDE, &wide);
        if (result != GHOSTTY_SUCCESS) return result;
      }
      if (length) {
        result = ghostty_render_state_row_cells_get(
            cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, out + text_offset);
        if (result != GHOSTTY_SUCCESS) return result;
      }
      uint32_t flags = has_fg | (has_bg << 1) | (style.bold << 2) |
          (style.italic << 3) | (style.faint << 4) | (style.inverse << 5) |
          (style.invisible << 6) | (style.strikethrough << 7) |
          (style.overline << 8) | ((style.underline != 0) << 9) | (selected << 10);
      uint8_t *cell = out + 8 + count * 24;
      put_u32(cell, flags);
      put_u32(cell + 4, length);
      put_u32(cell + 8, text_offset);
      put_u32(cell + 12, wide);
      cell[16] = fg.r; cell[17] = fg.g; cell[18] = fg.b;
      cell[19] = bg.r; cell[20] = bg.g; cell[21] = bg.b;
      cell[22] = 0; cell[23] = 0;
    }
    previous_length = length;
    count++;
  }
  *written = required;
  if (required > capacity) return GHOSTTY_OUT_OF_SPACE;
  put_u32(out, wrap | (continuation << 1));
  put_u32(out + 4, count);
  return GHOSTTY_SUCCESS;
}
