#import "T3MarkdownTextRun.h"
#import "T3MarkdownText.h"
#import "T3MarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/T3MarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/T3MarkdownTextSpec/Props.h>
#import <react/renderer/components/T3MarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface T3MarkdownTextRun () <RCTT3MarkdownTextRunViewProtocol>

@end

@implementation T3MarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<T3MarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const T3MarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<T3MarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<T3MarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::T3MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::T3MarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::T3MarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::T3MarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> T3MarkdownTextRunCls(void)
{
    return T3MarkdownTextRun.class;
}

@end
