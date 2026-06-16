#pragma once

#include <react/renderer/components/T3MarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/T3MarkdownTextSpec/Props.h>
#include <react/renderer/components/T3MarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char T3MarkdownTextRunComponentName[];

using T3MarkdownTextRunShadowNode = ConcreteViewShadowNode<
    T3MarkdownTextRunComponentName,
    T3MarkdownTextRunProps,
    T3MarkdownTextRunEventEmitter,
    T3MarkdownTextRunState>;
}
