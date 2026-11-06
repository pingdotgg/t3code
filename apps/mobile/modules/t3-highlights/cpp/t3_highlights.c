#include "t3_highlights.h"

#include <stdbool.h>
#include <string.h>

#include "highlights.h"
#include "wasm-rt-impl.h"

// The control block and buffer layout mirror the JavaScript glue in
// @pierre/highlights (`HighlightsHighlighter` in dist/highlighter.js).
#define INPUT_OFFSET WASM_DEFAULT_PAGE_SIZE
#define INPUT_PADDING 96u
#define MODE_UTF16_LINE_RECORDS 3u
// Like the JavaScript glue, a small input after a large one gets a fresh
// instance so the grown memory is released.
#define RESET_AFTER_PAGES 128u

struct w2c_env {
  w2c_highlights* instance;
};

static w2c_highlights instance;
static struct w2c_env env = {&instance};
static bool instantiated = false;

#include "generated/id_ranges.inc"

static bool in_ranges(const uint32_t ranges[][2], size_t count, uint32_t code_point) {
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t mid = low + (high - low) / 2;
    if (code_point < ranges[mid][0]) {
      high = mid;
    } else if (code_point > ranges[mid][1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

// Decodes like the JavaScript glue, including its leniency for malformed
// sequences, so both builds classify the same bytes the same way.
static u32 id_class(struct w2c_env* host, u32 ptr, u32 len, bool start) {
  wasm_rt_memory_t* memory = w2c_highlights_memory(host->instance);
  if ((uint64_t)ptr + 4 > memory->size) return 0;
  const uint8_t* b = memory->data + ptr;
  uint32_t code_point;
  if (len == 2) {
    code_point = (uint32_t)(b[0] & 31) << 6 | (b[1] & 63);
  } else if (len == 3) {
    code_point = (uint32_t)(b[0] & 15) << 12 | (uint32_t)(b[1] & 63) << 6 | (b[2] & 63);
  } else {
    code_point = (uint32_t)(b[0] & 7) << 18 | (uint32_t)(b[1] & 63) << 12 |
                 (uint32_t)(b[2] & 63) << 6 | (b[3] & 63);
  }
  if (code_point > 0x10ffff) return 0;
  return start ? in_ranges(id_start_ranges, sizeof(id_start_ranges) / sizeof(id_start_ranges[0]),
                           code_point)
               : in_ranges(id_continue_ranges,
                           sizeof(id_continue_ranges) / sizeof(id_continue_ranges[0]), code_point);
}

u32 w2c_env_is_id_start(struct w2c_env* host, u32 ptr, u32 len) {
  return id_class(host, ptr, len, true);
}

u32 w2c_env_is_id_continue(struct w2c_env* host, u32 ptr, u32 len) {
  return id_class(host, ptr, len, false);
}

static void reset_instance(void) {
  if (!instantiated) return;
  wasm2c_highlights_free(&instance);
  instantiated = false;
}

static void ensure_instance(void) {
  if (instantiated) return;
  wasm_rt_init();
  wasm2c_highlights_instantiate(&instance, &env);
  instantiated = true;
}

static void write_u32(uint8_t* at, uint32_t value) {
  at[0] = value & 0xff;
  at[1] = (value >> 8) & 0xff;
  at[2] = (value >> 16) & 0xff;
  at[3] = value >> 24;
}

static uint32_t read_u32(const uint8_t* at) {
  return (uint32_t)at[0] | (uint32_t)at[1] << 8 | (uint32_t)at[2] << 16 | (uint32_t)at[3] << 24;
}

int64_t t3_highlights_tokenize(const uint8_t* source, size_t length, uint8_t language,
                               const uint32_t** records) {
  *records = NULL;
  if (length > UINT32_MAX - WASM_DEFAULT_PAGE_SIZE * 2) return -1;

  if (instantiated && w2c_highlights_memory(&instance)->pages > RESET_AFTER_PAGES &&
      length <= WASM_DEFAULT_PAGE_SIZE) {
    reset_instance();
  }
  ensure_instance();

  wasm_rt_memory_t* memory = w2c_highlights_memory(&instance);
  uint64_t needed_pages = 1 + (length + INPUT_PADDING + WASM_DEFAULT_PAGE_SIZE - 1) / WASM_DEFAULT_PAGE_SIZE;
  if (needed_pages > memory->pages &&
      wasm_rt_grow_memory(memory, needed_pages - memory->pages) == (uint64_t)-1) {
    return -1;
  }

  uint8_t* data = memory->data;
  if (length > 0) memcpy(data + INPUT_OFFSET, source, length);
  data[INPUT_OFFSET + length] = 0;
  data[0] = language;
  data[1] = MODE_UTF16_LINE_RECORDS;
  write_u32(data + 2, (uint32_t)length);

  // `wasm_rt_impl_try` without the exception-handling runtime this module does
  // not use. A trap longjmps back here.
  WASM_RT_SAVE_STACK_DEPTH();
  if (WASM_RT_SETJMP(g_wasm_rt_jmp_buf) != WASM_RT_TRAP_NONE) {
    reset_instance();
    return -1;
  }
  w2c_highlights_highlight(&instance);

  // The lexer can grow memory, which moves it.
  data = memory->data;
  uint32_t start = read_u32(data + 6);
  uint32_t byte_length = read_u32(data + 10);
  if ((uint64_t)start + byte_length > memory->size || start % 4 != 0) return -1;
  *records = (const uint32_t*)(data + start);
  return byte_length / 4;
}
