#ifndef T3_HIGHLIGHTS_H
#define T3_HIGHLIGHTS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Lexes UTF-8 `source` with @pierre/highlights language `language` and points
 * `records` at `(endUtf16, tokenId)` pairs. A token ID of UINT32_MAX ends a
 * line, and its end value is where the next line starts. The records stay
 * valid until the next call. Returns the number of uint32 values, or -1 when
 * the lexer could not run.
 *
 * Not thread-safe: callers serialize access.
 */
int64_t t3_highlights_tokenize(const uint8_t* source, size_t length, uint8_t language,
                               const uint32_t** records);

#ifdef __cplusplus
}
#endif

#endif
