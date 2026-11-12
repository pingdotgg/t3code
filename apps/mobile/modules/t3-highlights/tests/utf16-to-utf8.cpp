#include <cstdint>
#include <cstdio>
#include <random>
#include <string>

#include "Utf16ToUtf8.hpp"

using margelo::nitro::t3highlights::appendUtf16AsUtf8;

static int failures = 0;

static std::string encode(const std::u16string& source, std::string out = {}) {
  appendUtf16AsUtf8(out, source.data(), source.size());
  return out;
}

static void expectBytes(const char* name, const std::string& actual, const std::string& expected) {
  if (actual == expected) return;
  failures++;
  std::fprintf(stderr, "%s: expected", name);
  for (unsigned char byte : expected) std::fprintf(stderr, " %02x", byte);
  std::fprintf(stderr, ", got");
  for (unsigned char byte : actual) std::fprintf(stderr, " %02x", byte);
  std::fprintf(stderr, "\n");
}

// One code unit or valid pair at a time, as a slow reference.
static std::string reference(const std::u16string& source) {
  std::string out;
  for (size_t at = 0; at < source.size(); at++) {
    uint32_t point = source[at];
    if (point >= 0xd800 && point <= 0xdbff && at + 1 < source.size() && source[at + 1] >= 0xdc00 &&
        source[at + 1] <= 0xdfff) {
      point = 0x10000 + ((point - 0xd800) << 10) + (source[++at] - 0xdc00);
    } else if (point >= 0xd800 && point <= 0xdfff) {
      point = 0xfffd;
    }
    if (point < 0x80) {
      out += static_cast<char>(point);
    } else if (point < 0x800) {
      out += static_cast<char>(0xc0 | (point >> 6));
      out += static_cast<char>(0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      out += static_cast<char>(0xe0 | (point >> 12));
      out += static_cast<char>(0x80 | ((point >> 6) & 0x3f));
      out += static_cast<char>(0x80 | (point & 0x3f));
    } else {
      out += static_cast<char>(0xf0 | (point >> 18));
      out += static_cast<char>(0x80 | ((point >> 12) & 0x3f));
      out += static_cast<char>(0x80 | ((point >> 6) & 0x3f));
      out += static_cast<char>(0x80 | (point & 0x3f));
    }
  }
  return out;
}

int main() {
  expectBytes("empty", encode(u""), "");
  expectBytes("nul", encode(std::u16string(u"a\0b", 3)), std::string("a\0b", 3));
  expectBytes("two-byte", encode(u"\u00e9\u07ff"), "\xc3\xa9\xdf\xbf");
  expectBytes("three-byte", encode(u"\u0800\u65e5\uffff"), "\xe0\xa0\x80\xe6\x97\xa5\xef\xbf\xbf");
  expectBytes("pair", encode(u"\U0001F389"), "\xf0\x9f\x8e\x89");
  expectBytes("lone high at end", encode(u"a\xd83c"), "a\xef\xbf\xbd");
  expectBytes("lone high before text", encode(u"\xd83cz"), "\xef\xbf\xbdz");
  expectBytes("high high low", encode(u"\xd83c\xd83c\xdf89"), "\xef\xbf\xbd\xf0\x9f\x8e\x89");
  expectBytes("lone low", encode(u"\xdf89"), "\xef\xbf\xbd");
  expectBytes("appends", encode(u"\u00e9", "ok "), "ok \xc3\xa9");
  // A high surrogate at the end of the input must not pair with the unit after it.
  const std::u16string pair = u"\U0001F389";
  std::string split;
  appendUtf16AsUtf8(split, pair.data(), 1);
  expectBytes("high at input end", split, "\xef\xbf\xbd");

  // Runs either side of the four-unit ASCII fast path, with a non-ASCII unit at every offset.
  for (size_t length = 0; length <= 12; length++) {
    for (size_t at = 0; at <= length; at++) {
      std::u16string source(length, u'x');
      if (at < length) source[at] = 0x00e9;
      expectBytes("fast path boundary", encode(source), reference(source));
    }
  }

  const char16_t pool[] = {u'a', u'\n', 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff};
  std::mt19937 random(7);
  for (int run = 0; run < 20000; run++) {
    std::u16string source(random() % 24, u' ');
    for (auto& unit : source) unit = pool[random() % (sizeof(pool) / sizeof(pool[0]))];
    expectBytes("random", encode(source), reference(source));
  }

  if (failures > 0) return 1;
  std::printf("utf16-to-utf8: ok\n");
  return 0;
}
