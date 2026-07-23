#pragma once

#include <react/renderer/components/T3MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/T3MarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char T3MarkdownTextComponentName[];

struct T3MarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct T3MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float T3MarkdownTextAttachmentSize(const T3MarkdownTextAttachmentRange &) {
  return 14;
}

inline Float T3MarkdownTextAttachmentBaselineOffset(
    const T3MarkdownTextAttachmentRange &) {
  return -2;
}

class T3MarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<T3MarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<T3MarkdownTextAttachmentRange> attachmentRanges;
};

class T3MarkdownTextShadowNode final : public ConcreteViewShadowNode<
T3MarkdownTextComponentName,
T3MarkdownTextProps,
T3MarkdownTextEventEmitter,
T3MarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  T3MarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<T3MarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<T3MarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
