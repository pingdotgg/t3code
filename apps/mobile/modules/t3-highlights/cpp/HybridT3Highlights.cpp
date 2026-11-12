#include "HybridT3Highlights.hpp"

#include <cstdint>
#include <mutex>

#include "t3_highlights.h"

namespace margelo::nitro::t3highlights {

namespace {
// The lexer's memory is process-global and every JS runtime shares it.
std::mutex lexerMutex;
} // namespace

std::optional<std::shared_ptr<ArrayBuffer>> HybridT3Highlights::tokenize(SourceText source,
                                                                         double language) {
  if (!(language >= 0 && language <= UINT8_MAX)) return std::nullopt;
  const auto languageId = static_cast<uint8_t>(language);
  if (languageId != language) return std::nullopt;

  std::lock_guard lock(lexerMutex);
  const uint32_t* records = nullptr;
  const int64_t count = t3_highlights_tokenize(reinterpret_cast<const uint8_t*>(source.utf8.data()),
                                               source.utf8.size(), languageId, &records);
  if (count < 0) return std::nullopt;
  const auto byteCount = static_cast<size_t>(count) * sizeof(uint32_t);
  if (records == nullptr || byteCount == 0) return ArrayBuffer::allocate(0);
  // The records live in the lexer's memory until its next run.
  return ArrayBuffer::copy(reinterpret_cast<const uint8_t*>(records), byteCount);
}

} // namespace margelo::nitro::t3highlights
