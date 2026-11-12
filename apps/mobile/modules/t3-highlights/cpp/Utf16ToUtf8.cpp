#include "Utf16ToUtf8.hpp"

#include <cstdint>
#include <cstring>

namespace margelo::nitro::t3highlights {

void appendUtf16AsUtf8(std::string& out, const char16_t* data, size_t length) {
  const size_t start = out.size();
  out.resize(start + length * 3);
  auto* const begin = reinterpret_cast<uint8_t*>(out.data());
  auto* write = begin + start;
  size_t at = 0;
  while (at < length) {
    // Runs of four ASCII code units are the common case in source code.
    if (at + 4 <= length) {
      uint64_t chunk;
      std::memcpy(&chunk, data + at, sizeof(chunk));
      if ((chunk & 0xff80ff80ff80ff80ULL) == 0) {
        write[0] = static_cast<uint8_t>(data[at]);
        write[1] = static_cast<uint8_t>(data[at + 1]);
        write[2] = static_cast<uint8_t>(data[at + 2]);
        write[3] = static_cast<uint8_t>(data[at + 3]);
        write += 4;
        at += 4;
        continue;
      }
    }
    uint32_t unit = data[at++];
    if (unit < 0x80) {
      *write++ = static_cast<uint8_t>(unit);
    } else if (unit < 0x800) {
      *write++ = static_cast<uint8_t>(0xc0 | (unit >> 6));
      *write++ = static_cast<uint8_t>(0x80 | (unit & 0x3f));
    } else {
      uint32_t codePoint = unit;
      if (unit >= 0xd800 && unit <= 0xdfff) {
        codePoint = 0xfffd;
        if (unit <= 0xdbff && at < length && data[at] >= 0xdc00 && data[at] <= 0xdfff) {
          codePoint = 0x10000 + ((unit - 0xd800) << 10) + (data[at++] - 0xdc00);
        }
      }
      if (codePoint < 0x10000) {
        *write++ = static_cast<uint8_t>(0xe0 | (codePoint >> 12));
        *write++ = static_cast<uint8_t>(0x80 | ((codePoint >> 6) & 0x3f));
        *write++ = static_cast<uint8_t>(0x80 | (codePoint & 0x3f));
      } else {
        *write++ = static_cast<uint8_t>(0xf0 | (codePoint >> 18));
        *write++ = static_cast<uint8_t>(0x80 | ((codePoint >> 12) & 0x3f));
        *write++ = static_cast<uint8_t>(0x80 | ((codePoint >> 6) & 0x3f));
        *write++ = static_cast<uint8_t>(0x80 | (codePoint & 0x3f));
      }
    }
  }
  out.resize(static_cast<size_t>(write - begin));
}

} // namespace margelo::nitro::t3highlights
