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

  bool operator==(const T3MarkdownTextParagraphStyleRange&) const = default;
};

struct T3MarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;

  bool operator==(const T3MarkdownTextAttachmentRange&) const = default;
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
  // Content must be derived from the current children whenever it is needed.
  // Yoga can invoke layout() on a fresh clone without ever calling
  // measureContent() on it (for example when both dimensions are already
  // exact), so caching measure-time content in mutable members and publishing
  // it from layout() lets state fall behind the children and drop text.
  struct Content {
    AttributedString attributedString;
    std::vector<T3MarkdownTextParagraphStyleRange> paragraphStyleRanges;
    std::vector<T3MarkdownTextAttachmentRange> attachmentRanges;
  };

  Content buildContent(const LayoutContext& layoutContext) const;
  void updateStateIfNeeded(Content&& content);
};
} // namespace facebook::React
