#pragma once

#include <cstddef>
#include <string>

namespace margelo::nitro::t3highlights {

/** Lone surrogates become U+FFFD, as with `jsi::String::utf8`. */
void appendUtf16AsUtf8(std::string& out, const char16_t* data, size_t length);

} // namespace margelo::nitro::t3highlights
