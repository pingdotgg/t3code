#import "T3SourceTextRun.h"
#import "RCTFabricComponentsPlugins.h"
#import "T3SourceTextRunComponentDescriptor.h"
#import <react/renderer/components/T3SourceTextSpec/Props.h>
#import <react/renderer/components/T3SourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface T3SourceTextRun () <RCTT3SourceTextRunViewProtocol>

@end

@implementation T3SourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      T3SourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const T3SourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<T3SourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<T3SourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> T3SourceTextRunCls(void) {
  return T3SourceTextRun.class;
}

@end
