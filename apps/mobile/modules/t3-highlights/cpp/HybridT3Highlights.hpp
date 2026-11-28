#pragma once

#include "HybridT3HighlightsSpec.hpp"

namespace margelo::nitro::t3highlights {

class HybridT3Highlights : public HybridT3HighlightsSpec {
public:
  HybridT3Highlights() : HybridObject(TAG) {}

  std::optional<std::shared_ptr<ArrayBuffer>> tokenize(SourceText source,
                                                       double language) override;
};

} // namespace margelo::nitro::t3highlights
