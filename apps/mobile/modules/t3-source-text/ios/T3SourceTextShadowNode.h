#pragma once

#include <react/renderer/components/T3SourceTextSpec/EventEmitters.h>
#include <react/renderer/components/T3SourceTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>

namespace facebook::react {

extern const char T3SourceTextComponentName[];

class T3SourceTextStateReal final {
public:
  AttributedString attributedString;
};

class T3SourceTextShadowNode final
    : public ConcreteViewShadowNode<T3SourceTextComponentName,
                                    T3SourceTextProps, T3SourceTextEventEmitter,
                                    T3SourceTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  T3SourceTextShadowNode(const ShadowNode &sourceShadowNode,
                         const ShadowNodeFragment &fragment);

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size
  measureContent(const LayoutContext &layoutContext,
                 const LayoutConstraints &layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
};
} // namespace facebook::react
