#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <mutex>
#include <utility>
#include <vector>

#include <ghostty/vt.h>

namespace {

constexpr uint32_t kSnapshotMagic = 0x54563354;  // "T3VT" in little endian.
constexpr uint16_t kSnapshotVersion = 1;
constexpr size_t kMaxScrollbackRows = 10000;

enum CellFlag : uint16_t {
  kBold = 1 << 0,
  kItalic = 1 << 1,
  kFaint = 1 << 2,
  kInverse = 1 << 3,
  kInvisible = 1 << 4,
  kStrikethrough = 1 << 5,
  kOverline = 1 << 6,
  kUnderline = 1 << 7,
  kSelected = 1 << 8,
};

struct Session {
  GhosttyTerminal terminal = nullptr;
  GhosttyRenderState render_state = nullptr;
  GhosttyRenderStateRowIterator row_iterator = nullptr;
  GhosttyRenderStateRowCells row_cells = nullptr;
  std::vector<uint8_t> responses;
  std::mutex mutex;
};

class ByteWriter {
 public:
  explicit ByteWriter(size_t capacity) { bytes_.reserve(capacity); }

  void U8(uint8_t value) { bytes_.push_back(value); }

  void U16(uint16_t value) {
    U8(static_cast<uint8_t>(value));
    U8(static_cast<uint8_t>(value >> 8));
  }

  void U32(uint32_t value) {
    U16(static_cast<uint16_t>(value));
    U16(static_cast<uint16_t>(value >> 16));
  }

  void Bytes(const std::vector<uint8_t>& value) {
    bytes_.insert(bytes_.end(), value.begin(), value.end());
  }

  std::vector<uint8_t> Take() { return std::move(bytes_); }

 private:
  std::vector<uint8_t> bytes_;
};

Session* FromHandle(jlong handle) {
  return reinterpret_cast<Session*>(static_cast<intptr_t>(handle));
}

jbyteArray ToJavaBytes(JNIEnv* env, const std::vector<uint8_t>& bytes) {
  auto result = env->NewByteArray(static_cast<jsize>(bytes.size()));
  if (result != nullptr && !bytes.empty()) {
    env->SetByteArrayRegion(result, 0, static_cast<jsize>(bytes.size()),
                            reinterpret_cast<const jbyte*>(bytes.data()));
  }
  return result;
}

GhosttyColorRgb RgbFromArgb(jint color) {
  const auto value = static_cast<uint32_t>(color);
  return {
      .r = static_cast<uint8_t>(value >> 16),
      .g = static_cast<uint8_t>(value >> 8),
      .b = static_cast<uint8_t>(value),
  };
}

uint32_t ArgbFromRgb(GhosttyColorRgb color) {
  return 0xFF000000U | (static_cast<uint32_t>(color.r) << 16U) |
         (static_cast<uint32_t>(color.g) << 8U) | color.b;
}

GhosttyColorRgb Blend(GhosttyColorRgb foreground, GhosttyColorRgb background,
                      uint8_t foreground_weight) {
  const auto blend = [foreground_weight](uint8_t front, uint8_t back) {
    const uint16_t back_weight = 255 - foreground_weight;
    return static_cast<uint8_t>((front * foreground_weight + back * back_weight) / 255);
  };
  return {
      .r = blend(foreground.r, background.r),
      .g = blend(foreground.g, background.g),
      .b = blend(foreground.b, background.b),
  };
}

void AppendUtf8(std::vector<uint8_t>* output, uint32_t codepoint) {
  if (codepoint <= 0x7F) {
    output->push_back(static_cast<uint8_t>(codepoint));
  } else if (codepoint <= 0x7FF) {
    output->push_back(static_cast<uint8_t>(0xC0 | (codepoint >> 6)));
    output->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3F)));
  } else if (codepoint <= 0xFFFF && !(codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
    output->push_back(static_cast<uint8_t>(0xE0 | (codepoint >> 12)));
    output->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 6) & 0x3F)));
    output->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3F)));
  } else if (codepoint <= 0x10FFFF) {
    output->push_back(static_cast<uint8_t>(0xF0 | (codepoint >> 18)));
    output->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 12) & 0x3F)));
    output->push_back(static_cast<uint8_t>(0x80 | ((codepoint >> 6) & 0x3F)));
    output->push_back(static_cast<uint8_t>(0x80 | (codepoint & 0x3F)));
  }
}

void OnWritePty(GhosttyTerminal, void* userdata, const uint8_t* data, size_t len) {
  auto* session = static_cast<Session*>(userdata);
  if (session == nullptr || data == nullptr || len == 0) return;
  session->responses.insert(session->responses.end(), data, data + len);
}

void ApplyTheme(Session* session, jint foreground, jint background, jint cursor,
                JNIEnv* env, jintArray palette_array) {
  auto foreground_rgb = RgbFromArgb(foreground);
  auto background_rgb = RgbFromArgb(background);
  auto cursor_rgb = RgbFromArgb(cursor);
  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
                       &foreground_rgb);
  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
                       &background_rgb);
  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor_rgb);

  if (palette_array == nullptr) return;
  const auto palette_length = env->GetArrayLength(palette_array);
  if (palette_length <= 0) return;

  GhosttyColorRgb palette[256];
  if (ghostty_terminal_get(session->terminal,
                           GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT,
                           palette) != GHOSTTY_SUCCESS) {
    return;
  }

  const auto copied_length = std::min<jsize>(palette_length, 256);
  std::vector<jint> colors(static_cast<size_t>(copied_length));
  env->GetIntArrayRegion(palette_array, 0, copied_length, colors.data());
  for (jsize index = 0; index < copied_length; ++index) {
    palette[index] = RgbFromArgb(colors[index]);
  }
  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palette);
}

void FreeSession(Session* session) {
  if (session == nullptr) return;
  ghostty_render_state_row_cells_free(session->row_cells);
  ghostty_render_state_row_iterator_free(session->row_iterator);
  ghostty_render_state_free(session->render_state);
  ghostty_terminal_free(session->terminal);
  delete session;
}

std::vector<uint8_t> DrainResponses(Session* session) {
  std::vector<uint8_t> responses;
  responses.swap(session->responses);
  return responses;
}

uint16_t StyleFlags(const GhosttyStyle& style, bool selected) {
  uint16_t flags = 0;
  if (style.bold) flags |= kBold;
  if (style.italic) flags |= kItalic;
  if (style.faint) flags |= kFaint;
  if (style.inverse) flags |= kInverse;
  if (style.invisible) flags |= kInvisible;
  if (style.strikethrough) flags |= kStrikethrough;
  if (style.overline) flags |= kOverline;
  if (style.underline != 0) flags |= kUnderline;
  if (selected) flags |= kSelected;
  return flags;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeCreate(
    JNIEnv* env, jclass, jint cols, jint rows, jint cell_width, jint cell_height,
    jint foreground, jint background, jint cursor, jintArray palette) {
  auto* session = new Session();
  GhosttyTerminalOptions options = {
      .cols = static_cast<uint16_t>(std::clamp(cols, 1, 65535)),
      .rows = static_cast<uint16_t>(std::clamp(rows, 1, 65535)),
      .max_scrollback = kMaxScrollbackRows,
  };
  if (ghostty_terminal_new(nullptr, &session->terminal, options) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(nullptr, &session->render_state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(nullptr, &session->row_iterator) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(nullptr, &session->row_cells) != GHOSTTY_SUCCESS) {
    FreeSession(session);
    return 0;
  }

  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, session);
  ghostty_terminal_set(session->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY,
                       reinterpret_cast<const void*>(OnWritePty));
  ApplyTheme(session, foreground, background, cursor, env, palette);
  ghostty_terminal_resize(session->terminal, options.cols, options.rows,
                          static_cast<uint32_t>(std::max(cell_width, 1)),
                          static_cast<uint32_t>(std::max(cell_height, 1)));
  return static_cast<jlong>(reinterpret_cast<intptr_t>(session));
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeDestroy(JNIEnv*, jclass, jlong handle) {
  FreeSession(FromHandle(handle));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeFeed(JNIEnv* env, jclass, jlong handle,
                                                       jbyteArray data) {
  auto* session = FromHandle(handle);
  if (session == nullptr || data == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(session->mutex);
  const auto length = env->GetArrayLength(data);
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  if (length > 0) {
    env->GetByteArrayRegion(data, 0, length, reinterpret_cast<jbyte*>(bytes.data()));
    ghostty_terminal_vt_write(session->terminal, bytes.data(), bytes.size());
  }
  return ToJavaBytes(env, DrainResponses(session));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeResize(
    JNIEnv* env, jclass, jlong handle, jint cols, jint rows, jint cell_width, jint cell_height) {
  auto* session = FromHandle(handle);
  if (session == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(session->mutex);
  ghostty_terminal_resize(session->terminal,
                          static_cast<uint16_t>(std::clamp(cols, 1, 65535)),
                          static_cast<uint16_t>(std::clamp(rows, 1, 65535)),
                          static_cast<uint32_t>(std::max(cell_width, 1)),
                          static_cast<uint32_t>(std::max(cell_height, 1)));
  return ToJavaBytes(env, DrainResponses(session));
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeScroll(JNIEnv*, jclass, jlong handle,
                                                         jint rows) {
  auto* session = FromHandle(handle);
  if (session == nullptr || rows == 0) return;
  std::lock_guard<std::mutex> lock(session->mutex);
  GhosttyTerminalScrollViewport scroll = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
      .value = {.delta = rows},
  };
  ghostty_terminal_scroll_viewport(session->terminal, scroll);
}

extern "C" JNIEXPORT void JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeSetTheme(
    JNIEnv* env, jclass, jlong handle, jint foreground, jint background, jint cursor,
    jintArray palette) {
  auto* session = FromHandle(handle);
  if (session == nullptr) return;
  std::lock_guard<std::mutex> lock(session->mutex);
  ApplyTheme(session, foreground, background, cursor, env, palette);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_expo_modules_t3terminal_GhosttyBridge_nativeSnapshot(JNIEnv* env, jclass,
                                                           jlong handle) {
  auto* session = FromHandle(handle);
  if (session == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(session->mutex);

  if (ghostty_render_state_update(session->render_state, session->terminal) != GHOSTTY_SUCCESS) {
    return env->NewByteArray(0);
  }

  uint16_t cols = 0;
  uint16_t rows = 0;
  bool cursor_visible = false;
  bool cursor_in_viewport = false;
  bool cursor_blinking = false;
  uint16_t cursor_x = 0xFFFF;
  uint16_t cursor_y = 0xFFFF;
  GhosttyRenderStateCursorVisualStyle cursor_style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(session->render_state, GHOSTTY_RENDER_STATE_DATA_COLS, &cols);
  ghostty_render_state_get(session->render_state, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows);
  ghostty_render_state_get(session->render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
                           &cursor_visible);
  ghostty_render_state_get(session->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
                           &cursor_in_viewport);
  ghostty_render_state_get(session->render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
                           &cursor_blinking);
  ghostty_render_state_get(session->render_state,
                           GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &cursor_style);
  if (cursor_in_viewport) {
    ghostty_render_state_get(session->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &cursor_x);
    ghostty_render_state_get(session->render_state,
                             GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &cursor_y);
  }

  GhosttyRenderStateColors colors{};
  colors.size = sizeof(colors);
  if (ghostty_render_state_colors_get(session->render_state, &colors) != GHOSTTY_SUCCESS) {
    return env->NewByteArray(0);
  }
  const auto cursor_color = colors.cursor_has_value ? colors.cursor : colors.foreground;

  ByteWriter writer(32 + static_cast<size_t>(cols) * rows * 14);
  writer.U32(kSnapshotMagic);
  writer.U16(kSnapshotVersion);
  writer.U16(cols);
  writer.U16(rows);
  writer.U16(cursor_x);
  writer.U16(cursor_y);
  writer.U8(cursor_visible && cursor_in_viewport ? 1 : 0);
  writer.U8(static_cast<uint8_t>(cursor_style));
  writer.U8(cursor_blinking ? 1 : 0);
  writer.U8(0);
  writer.U32(ArgbFromRgb(colors.foreground));
  writer.U32(ArgbFromRgb(colors.background));
  writer.U32(ArgbFromRgb(cursor_color));

  if (ghostty_render_state_get(session->render_state,
                               GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                               &session->row_iterator) != GHOSTTY_SUCCESS) {
    return env->NewByteArray(0);
  }

  uint16_t written_rows = 0;
  while (written_rows < rows &&
         ghostty_render_state_row_iterator_next(session->row_iterator)) {
    if (ghostty_render_state_row_get(session->row_iterator,
                                     GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                                     &session->row_cells) != GHOSTTY_SUCCESS) {
      break;
    }

    uint16_t written_cols = 0;
    while (written_cols < cols && ghostty_render_state_row_cells_next(session->row_cells)) {
      GhosttyStyle style{};
      style.size = sizeof(style);
      bool selected = false;
      GhosttyColorRgb foreground = colors.foreground;
      GhosttyColorRgb background = colors.background;
      ghostty_render_state_row_cells_get(session->row_cells,
                                         GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
                                         &style);
      ghostty_render_state_row_cells_get(session->row_cells,
                                         GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED,
                                         &selected);
      ghostty_render_state_row_cells_get(session->row_cells,
                                         GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
                                         &foreground);
      ghostty_render_state_row_cells_get(session->row_cells,
                                         GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
                                         &background);
      if (style.inverse) std::swap(foreground, background);
      if (style.faint) foreground = Blend(foreground, background, 155);

      uint32_t grapheme_count = 0;
      ghostty_render_state_row_cells_get(
          session->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
          &grapheme_count);
      std::vector<uint8_t> utf8;
      if (grapheme_count > 0) {
        std::vector<uint32_t> codepoints(grapheme_count);
        if (ghostty_render_state_row_cells_get(
                session->row_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
                codepoints.data()) == GHOSTTY_SUCCESS) {
          utf8.reserve(grapheme_count * 4);
          for (const auto codepoint : codepoints) AppendUtf8(&utf8, codepoint);
        }
      }

      const auto text_length = static_cast<uint16_t>(std::min<size_t>(utf8.size(), 65535));
      writer.U32(ArgbFromRgb(foreground));
      writer.U32(ArgbFromRgb(background));
      writer.U16(StyleFlags(style, selected));
      writer.U16(text_length);
      if (text_length != utf8.size()) utf8.resize(text_length);
      writer.Bytes(utf8);
      ++written_cols;
    }

    while (written_cols++ < cols) {
      writer.U32(ArgbFromRgb(colors.foreground));
      writer.U32(ArgbFromRgb(colors.background));
      writer.U16(0);
      writer.U16(0);
    }
    ++written_rows;
  }

  while (written_rows++ < rows) {
    for (uint16_t column = 0; column < cols; ++column) {
      writer.U32(ArgbFromRgb(colors.foreground));
      writer.U32(ArgbFromRgb(colors.background));
      writer.U16(0);
      writer.U16(0);
    }
  }

  return ToJavaBytes(env, writer.Take());
}
