#pragma once

#include "T3MarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using T3MarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<T3MarkdownTextRunShadowNode>;

void T3MarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
