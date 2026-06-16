#pragma once

#include "T3MarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using T3MarkdownTextComponentDescriptor = ConcreteComponentDescriptor<T3MarkdownTextShadowNode>;

void T3MarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
