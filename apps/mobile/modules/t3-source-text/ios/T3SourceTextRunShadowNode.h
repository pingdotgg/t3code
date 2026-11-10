#pragma once

#include <react/renderer/components/T3SourceTextSpec/EventEmitters.h>
#include <react/renderer/components/T3SourceTextSpec/Props.h>
#include <react/renderer/components/T3SourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char T3SourceTextRunComponentName[];

using T3SourceTextRunShadowNode =
    ConcreteViewShadowNode<T3SourceTextRunComponentName, T3SourceTextRunProps,
                           T3SourceTextRunEventEmitter, T3SourceTextRunState>;
} // namespace facebook::react
